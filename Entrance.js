/**
 * 节点信息(入口版)
 *
 * 参数
 * - [retries] 重试次数 默认 1
 * - [retry_delay] 重试延时(单位: 毫秒) 默认 1000
 * - [concurrency] 并发数 默认 10
 * - [internal] 使用内部方法获取 IP 信息. 默认 false
 *              支持以下几种运行环境:
 *              1. Surge/Loon(build >= 692) 等有 $utils.ipaso 和 $utils.geoip API 的 App
 *              2. Node.js 版 Sub-Store, 设置环境变量 SUB_STORE_MMDB_COUNTRY_PATH 和 SUB_STORE_MMDB_ASN_PATH, 或 传入 mmdb_country_path 和 mmdb_asn_path 参数(分别为 MaxMind GeoLite2 Country 和 GeoLite2 ASN 数据库 的路径)
 *              数据来自 GeoIP 数据库
 *              ⚠️ 要求节点服务器为 IP. 本脚本不进行域名解析 可在节点操作中添加域名解析
 * - [method] 请求方法. 默认 get
 * - [timeout] 请求超时(单位: 毫秒) 默认 5000
 * - [api] 测入口的 API . 默认为 http://ip-api.com/json/{{proxy.server}}?lang=zh-CN
 * - [format] 自定义格式, 从 节点(proxy) 和 入口(api)中取数据. 默认为: {{api.country}} {{api.isp}} - {{proxy.name}}
 *            当使用 internal 时, 默认为 {{api.countryCode}} {{api.aso}} - {{proxy.name}}
 * - [valid] 验证 api 请求是否合法. 默认: ProxyUtils.isIP('{{api.ip || api.query}}')
 *           当使用 internal 时, 默认为 "{{api.countryCode || api.aso}}".length > 0
 * - [uniq_key] 设置缓存唯一键名包含的节点数据字段名匹配正则. 默认为 ^server$ 即服务器地址相同的节点共享缓存
 * - [ignore_failed_error] 忽略失败缓存. 默认不忽略失败缓存. 若设置为忽略, 之前失败的结果即使有缓存也会再测一次
 * - [entrance] 在节点上附加 _entrance 字段(API 响应数据), 默认不附加
 * - [remove_failed] 移除失败的节点. 默认不移除.
 * - [mmdb_country_path] 见 internal
 * - [mmdb_asn_path] 见 internal
 * - [cache] 使用缓存, 默认不使用缓存
 * 关于缓存时长
 * 当使用相关脚本时, 若在对应的脚本中使用参数开启缓存, 可设置持久化缓存 sub-store-csr-expiration-time 的值来自定义默认缓存时长, 默认为 172800000 (48 * 3600 * 1000, 即 48 小时)
 * 🎈Loon 可在插件中设置
 * 其他平台同理, 持久化缓存数据在 JSON 里
 */

const lodash = require('lodash');

// 定义一个异步函数 operator，用于处理代理服务器列表，并根据目标平台和上下文进行操作
async function operator(proxies = [], targetPlatform, context) {
  const { isNode } = context.env;
  const {
    internal = false,
    mmdb_country_path,
    mmdb_asn_path,
    valid = 'ProxyUtils.isIP(\'{{api.ip || api.query}}\')',
    format = '{{api.country}} {{api.city}}',
    ignore_failed_error = false,
    remove_failed = false,
    entrance = false,
    cache = false,
    uniq_key = '^server$',
    method = 'get',
    api = 'http://ip-api.com/json/{{proxy.server}}?lang=zh-CN',
    concurrency = 10,
    retries = 1,
    retry_delay = 1000,
    timeout = 5000
  } = context.arguments;

  let utils;
  if (internal) {
    if (isNode) {
      utils = new ProxyUtils.MMDB({ country: mmdb_country_path, asn: mmdb_asn_path });
      console.info(`[MMDB] GeoLite2 Country 数据库文件路径: ${mmdb_country_path || process.env.SUB_STORE_MMDB_ASN_PATH}`);
      console.info(`[MMDB] GeoLite2 ASN 数据库文件路径: ${mmdb_asn_path || process.env.SUB_STORE_MMDB_COUNTRY_PATH}`);
    } else {
      if (typeof $utils === 'undefined' || typeof $utils.geoip === 'undefined' || typeof $utils.ipaso === 'undefined') {
        console.error('目前仅支持 Surge/Loon(build >= 692) 等有 $utils.ipaso 和 $utils.geoip API 的 App');
        throw new Error('不支持使用内部方法获取 IP 信息, 请查看日志');
      }
      utils = $utils;
    }
    format = '{{api.countryCode}} {{api.aso}} - {{proxy.name}}';
    valid = '"{{api.countryCode || api.aso}}".length > 0';
  }

  const executeAsyncTasks = async (tasks, { concurrency = 1 } = {}) => {
    const results = [];
    const executing = new Set();

    for (const task of tasks) {
      const p = Promise.resolve().then(() => task());
      results.push(p);
      executing.add(p);

      const r = await Promise.race(executing);
      executing.delete(r);
    }

    return Promise.all(results);
  };

  const checkProxy = async (proxy) => {
    const id = cache ? `entrance:${api}:${format}:${internal}:${JSON.stringify(lodash.pick(proxy, ['server']))}` : undefined;

    if (cache && cache.get(id)) {
      const cached = cache.get(id);
      if (cached.api) {
        console.info(`[${proxy.name}] 使用成功缓存`);
        proxy.name = formatter({ proxy, api: cached.api, format });
        proxy._entrance = cached.api;
        return;
      } else if (!ignore_failed_error) {
        console.info(`[${proxy.name}] 使用失败缓存`);
        return;
      }
    }

    const apiResponse = await fetchApi(proxy);
    if (apiResponse) {
      proxy.name = formatter({ proxy, api: apiResponse, format });
      proxy._entrance = apiResponse;
      if (cache) {
        cache.set(id, { api: apiResponse });
      }
    } else if (cache) {
      cache.set(id, {});
    }
  };

  const fetchApi = async (proxy) => {
    try {
      const response = await http({
        method,
        headers: {
          'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3.1 Mobile/15E148 Safari/604.1',
        },
        url: formatter({ proxy, format: api }),
        timeout,
        retries,
        retry_delay
      });

      const apiResponse = JSON.parse(response.body);
      const status = parseInt(response.status || response.statusCode || 200);
      if (status === 200 && isValidResponse(apiResponse)) {
        return apiResponse;
      }
    } catch (e) {
      console.error(e);
    }
    return null;
  };

  const isValidResponse = (apiResponse) => {
    const validExpression = formatter({ api: apiResponse, format: valid });
    return Function('"use strict";return (' + validExpression + ');')();
  };

  const formatter = ({ proxy = {}, api = {}, format = '' }) => {
    return format.replace(/\{\{(.*?)\}\}/g, (_, key) => lodash.get({ proxy, api }, key));
  };

  const http = async (opt = {}) => {
    const { method, url, headers, timeout, retries, retry_delay } = opt;
    let attempt = 0;

    while (attempt < retries) {
      try {
        const controller = new AbortController();
        const signal = controller.signal;
        const response = await fetch(url, { method, headers, signal });

        if (response.ok) {
          return {
            body: await response.text(),
            status: response.status
          };
        } else {
          throw new Error(`HTTP error! status: ${response.status}`);
        }
      } catch (error) {
        if (attempt === retries - 1) throw error;
        attempt++;
        await new Promise(resolve => setTimeout(resolve, retry_delay));
      }
    }
  };

  await executeAsyncTasks(proxies.map(proxy => () => checkProxy(proxy)), { concurrency });

  if (remove_failed) {
    proxies = proxies.filter(p => p._entrance);
  }

  if (!entrance) {
    proxies.forEach(p => delete p._entrance);
  }

  return proxies;
}
