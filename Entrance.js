/**
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
 * - [format] 自定义格式, 从 节点(proxy) 和 入口(api)中取数据. 默认为: {{proxy.name}}-{{api.country}} {{api.isp}}
 *            当使用 internal 时, 默认为 {{proxy.name}}-{{api.countryCode}} {{api.aso}}
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

async function operator(proxies = [], targetPlatform, context) {
  const $ = $substore;
  const { isNode } = $.env;
  const internal = $arguments.internal;
  const mmdb_country_path = $arguments.mmdb_country_path;
  const mmdb_asn_path = $arguments.mmdb_asn_path;
  let valid = $arguments.valid || `ProxyUtils.isIP('{{api.ip || api.query}}')`;
  let format = $arguments.format || `{{proxy.name}}-{{api.country}} {{api.isp}}`;
  let utils;

  // 初始化工具类
  if (internal) {
    if (isNode) {
      utils = new ProxyUtils.MMDB({ country: mmdb_country_path, asn: mmdb_asn_path });
      $.info(`[MMDB] GeoLite2 Country 数据库文件路径: ${mmdb_country_path || eval('process.env.SUB_STORE_MMDB_ASN_PATH')}`);
      $.info(`[MMDB] GeoLite2 ASN 数据库文件路径: ${mmdb_asn_path || eval('process.env.SUB_STORE_MMDB_COUNTRY_PATH')}`);
    } else {
      if (typeof $utils === 'undefined' || typeof $utils.geoip === 'undefined' || typeof $utils.ipaso === 'undefined') {
        $.error(`目前仅支持 Surge/Loon(build >= 692) 等有 $utils.ipaso 和 $utils.geoip API 的 App`);
        throw new Error('不支持使用内部方法获取 IP 信息, 请查看日志');
      }
      utils = $utils;
    }
    format = $arguments.format || `{{proxy.name}}-{{api.countryCode}} {{api.aso}}`;
    valid = $arguments.valid || `"{{api.countryCode || api.aso}}".length > 0`;
  }

  const ignore_failed_error = $arguments.ignore_failed_error;
  const remove_failed = $arguments.remove_failed;
  const entranceEnabled = $arguments.entrance;
  const cacheEnabled = $arguments.cache;
  const uniq_key = $arguments.uniq_key || '^server$';
  const cache = scriptResourceCache;
  const method = $arguments.method || 'get';
  const url = $arguments.api || `http://ip-api.com/json/{{proxy.server}}?lang=zh-CN`;
  const concurrency = parseInt($arguments.concurrency || 10); // 一组并发数

  // 并发执行节点检测
  await executeAsyncTasks(
    proxies.map(proxy => () => check(proxy)),
    { concurrency }
  );

  // 移除失败的节点
  if (remove_failed) {
    proxies = proxies.filter(p => p._entrance);
  }

  // 清理不需要的 _entrance 字段
  if (!entranceEnabled) {
    proxies = proxies.map(p => {
      delete p._entrance;
      return p;
    });
  }

  return proxies;

  // 检测节点
  async function check(proxy) {
    const id = cacheEnabled
      ? `entrance:${url}:${format}:${internal}:${JSON.stringify(
          Object.fromEntries(
            Object.entries(proxy).filter(([key]) => new RegExp(uniq_key).test(key))
          )
        )}`
      : undefined;

    try {
      const cached = cache.get(id);
      if (cacheEnabled && cached) {
        if (cached.api) {
          $.info(`[${proxy.name}] 使用成功缓存`);
          proxy.name = formatter({ proxy, api: cached.api, format });
          proxy._entrance = cached.api;
          return;
        } else if (!ignore_failed_error) {
          $.info(`[${proxy.name}] 使用失败缓存`);
          return;
        }
      }

      // 请求
      const startedAt = Date.now();
      let api = {};
      if (internal) {
        api = {
          countryCode: utils.geoip(proxy.server) || '',
          aso: utils.ipaso(proxy.server) || '',
        };
        $.info(`[${proxy.name}] countryCode: ${api.countryCode}, aso: ${api.aso}`);
        if ((api.countryCode || api.aso) && eval(formatter({ api, format: valid }))) {
          proxy.name = formatter({ proxy, api, format });
          proxy._entrance = api;
          if (cacheEnabled) {
            $.info(`[${proxy.name}] 设置成功缓存`);
            cache.set(id, { api });
          }
        } else {
          if (cacheEnabled) {
            $.info(`[${proxy.name}] 设置失败缓存`);
            cache.set(id, {});
          }
        }
      } else {
        const res = await http({
          method,
          headers: {
            'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3.1 Mobile/15E148 Safari/604.1',
          },
          url: formatter({ proxy, format: url }),
        });
        api = String(lodash_get(res, 'body'));
        try {
          api = JSON.parse(api);
        } catch (e) {}
        const status = parseInt(res.status || res.statusCode || 200);
        const latency = `${Date.now() - startedAt}`;
        $.info(`[${proxy.name}] status: ${status}, latency: ${latency}`);
        if (status == 200 && eval(formatter({ api, format: valid }))) {
          proxy.name = formatter({ proxy, api, format });
          proxy._entrance = api;
          if (cacheEnabled) {
            $.info(`[${proxy.name}] 设置成功缓存`);
            cache.set(id, { api });
          }
        } else {
          if (cacheEnabled) {
            $.info(`[${proxy.name}] 设置失败缓存`);
            cache.set(id, {});
          }
        }
      }
      $.log(`[${proxy.name}] api: ${JSON.stringify(api, null, 2)}`);
    } catch (e) {
      $.error(`[${proxy.name}] ${e.message ?? e}`);
      if (cacheEnabled) {
        $.info(`[${proxy.name}] 设置失败缓存`);
        cache.set(id, {});
      }
    }
  }

  // HTTP 请求
  async function http(opt = {}) {
    const METHOD = opt.method || 'get';
    const TIMEOUT = parseFloat(opt.timeout || $arguments.timeout || 5000);
    const RETRIES = parseFloat(opt.retries ?? $arguments.retries ?? 1);
    const RETRY_DELAY = parseFloat(opt.retry_delay ?? $arguments.retry_delay ?? 1000);

    let count = 0;
    const fn = async () => {
      try {
        return await $.http[METHOD]({ ...opt, timeout: TIMEOUT });
      } catch (e) {
        if (count < RETRIES) {
          count++;
          const delay = RETRY_DELAY * count;
          await $.wait(delay);
          return await fn();
        } else {
          throw e;
        }
      }
    };
    return await fn();
  }

  // 从对象中获取指定路径的值
  function lodash_get(source, path, defaultValue = undefined) {
    const paths = path.replace(/\[(\d+)\]/g, '.$1').split('.');
    let result = source;
    for (const p of paths) {
      result = Object(result)[p];
      if (result === undefined) {
        return defaultValue;
      }
    }
    return result;
  }

  // 格式化字符串
  function formatter({ proxy = {}, api = {}, format = '' }) {
    let f = format.replace(/\{\{(.*?)\}\}/g, '${$1}');
    return eval(`\`${f}\``);
  }

  // 并发执行任务
  function executeAsyncTasks(tasks, { concurrency = 1 } = {}) {
    return new Promise(async (resolve, reject) => {
      try {
        let running = 0;
        let index = 0;

        function executeNextTask() {
          while (index < tasks.length && running < concurrency) {
            const taskIndex = index++;
            const currentTask = tasks[taskIndex];
            running++;

            currentTask()
              .finally(() => {
                running--;
                executeNextTask();
              });
          }

          if (running === 0) {
            resolve();
          }
        }

        await executeNextTask();
      } catch (e) {
        reject(e);
      }
    });
  }
}
