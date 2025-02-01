/**
 * 节点信息(入口版)
 *
 * ⚠️ 本脚本不进行域名解析 如有需要 可在节点操作中添加域名解析
 
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

async function operator(proxies = [], targetPlatform, context) {
  const $ = $substore; // 获取 Sub-Store 的全局对象
  const { isNode } = $.env; // 判断当前环境是否为 Node.js
  const internal = $arguments.internal; // 是否使用内部方法获取 IP 信息
  const mmdb_country_path = $arguments.mmdb_country_path; // GeoLite2 Country 数据库路径
  const mmdb_asn_path = $arguments.mmdb_asn_path; // GeoLite2 ASN 数据库路径
  let valid = $arguments.valid || `ProxyUtils.isIP('{{api.ip || api.query}}')`; // 验证 API 请求是否合法的表达式
  let format = $arguments.format || `{{proxy.name}}-{{api.isp}}`; // 自定义格式
  let utils; // 工具对象，用于内部方法获取 IP 信息

  // 初始化内部方法工具
  if (internal) {
    if (isNode) {
      // 如果是 Node.js 环境，使用 MMDB 工具
      utils = new ProxyUtils.MMDB({ country: mmdb_country_path, asn: mmdb_asn_path });
      $.info(
        `[MMDB] GeoLite2 Country 数据库文件路径: ${mmdb_country_path || eval('process.env.SUB_STORE_MMDB_ASN_PATH')}`
      );
      $.info(`[MMDB] GeoLite2 ASN 数据库文件路径: ${mmdb_asn_path || eval('process.env.SUB_STORE_MMDB_COUNTRY_PATH')}`);
    } else {
      // 如果不是 Node.js 环境，检查是否支持内部方法
      if (typeof $utils === 'undefined' || typeof $utils.geoip === 'undefined' || typeof $utils.ipaso === 'undefined') {
        $.error(`目前仅支持 Surge/Loon(build >= 692) 等有 $utils.ipaso 和 $utils.geoip API 的 App`);
        throw new Error('不支持使用内部方法获取 IP 信息, 请查看日志');
      }
      utils = $utils; // 使用 Surge/Loon 提供的工具
    }
    format = $arguments.format || `{{proxy.name}}-{{api.isp}}`; // 使用内部方法时的默认格式
    valid = $arguments.valid || `"{{api.countryCode || api.aso}}".length > 0`; // 使用内部方法时的验证表达式
  }

  const ignore_failed_error = $arguments.ignore_failed_error; // 是否忽略失败缓存
  const remove_failed = $arguments.remove_failed; // 是否移除失败的节点
  const entranceEnabled = $arguments.entrance; // 是否在节点上附加 _entrance 字段
  const cacheEnabled = $arguments.cache; // 是否使用缓存
  const uniq_key = $arguments.uniq_key || '^server$'; // 缓存唯一键名的正则表达式
  const cache = scriptResourceCache; // 缓存对象
  const method = $arguments.method || 'get'; // 请求方法，默认为 GET
  const url = $arguments.api || `http://ip-api.com/json/{{proxy.server}}?lang=zh-CN`; // 测入口的 API
  const concurrency = parseInt($arguments.concurrency || 10); // 并发数，默认为 10

  // 并发执行节点检测
  await executeAsyncTasks(
    proxies.map(proxy => () => check(proxy)), // 将每个节点的检测任务映射为一个函数
    { concurrency } // 控制并发数
  );

  // 移除失败的节点
  if (remove_failed) {
    proxies = proxies.filter(p => {
      if (remove_failed && !p._entrance) { // 如果节点没有 _entrance 字段，则认为失败
        return false;
      }
      return true;
    });
  }

  // 移除 _entrance 字段
  if (!entranceEnabled) {
    proxies = proxies.map(p => {
      if (!entranceEnabled) {
        delete p._entrance; // 删除 _entrance 字段
      }
      return p;
    });
  }

  return proxies; // 返回处理后的节点列表

  // 检测节点
  async function check(proxy) {
    const id = cacheEnabled
      ? `entrance:${url}:${format}:${internal}:${JSON.stringify(
          Object.fromEntries(
            Object.entries(proxy).filter(([key]) => {
              const re = new RegExp(uniq_key); // 根据正则表达式过滤节点字段
              return re.test(key);
            })
          )
        )}`
      : undefined; // 生成缓存唯一键名

    try {
      const cached = cache.get(id); // 获取缓存
      if (cacheEnabled && cached) {
        if (cached.api) {
          $.info(`[${proxy.name}] 使用成功缓存`);
          $.log(`[${proxy.name}] api: ${JSON.stringify(cached.api, null, 2)}`);
          proxy.name = formatter({ format, proxy, api: cached.api}); // 格式化节点名称
          proxy._entrance = cached.api; // 附加 _entrance 字段
          return;
        } else {
          if (ignore_failed_error) {
            $.info(`[${proxy.name}] 忽略失败缓存`);
          } else {
            $.info(`[${proxy.name}] 使用失败缓存`);
            return;
          }
        }
      }

      // 请求
      const startedAt = Date.now(); // 记录请求开始时间
      let api = {};
      if (internal) {
        // 使用内部方法获取 IP 信息
        api = {
          countryCode: utils.geoip(proxy.server) || '', // 获取国家代码
          aso: utils.ipaso(proxy.server) || '', // 获取 ASO 信息
        };
        $.info(`[${proxy.name}] countryCode: ${api.countryCode}, aso: ${api.aso}`);
        if ((api.countryCode || api.aso) && eval(formatter({ api, format: valid }))) { // 验证 IP 信息
          proxy.name = formatter({ format, proxy, api}); // 格式化节点名称
          proxy._entrance = api; // 附加 _entrance 字段
          if (cacheEnabled) {
            $.info(`[${proxy.name}] 设置成功缓存`);
            cache.set(id, { api }); // 设置缓存
          }
        } else {
          if (cacheEnabled) {
            $.info(`[${proxy.name}] 设置失败缓存`);
            cache.set(id, {}); // 设置失败缓存
          }
        }
      } else {
        // 使用外部 API 获取 IP 信息
        const res = await http({
          method,
          headers: {
            'User-Agent':
              'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3.1 Mobile/15E148 Safari/604.1',
          },
          url: formatter({ proxy, format: url }), // 格式化请求 URL
        });
        api = String(lodash_get(res, 'body')); // 获取响应体
        try {
          api = JSON.parse(api); // 尝试解析 JSON
        } catch (e) {}
        const status = parseInt(res.status || res.statusCode || 200); // 获取 HTTP 状态码
        let latency = `${Date.now() - startedAt}`; // 计算请求延迟
        $.info(`[${proxy.name}] status: ${status}, latency: ${latency}`);
        if (status == 200 && eval(formatter({ api, format: valid }))) { // 验证 API 响应
          proxy.name = formatter({ format, proxy, api }); // 格式化节点名称
          proxy._entrance = api; // 附加 _entrance 字段
          if (cacheEnabled) {
            $.info(`[${proxy.name}] 设置成功缓存`);
            cache.set(id, { api }); // 设置缓存
          }
        } else {
          if (cacheEnabled) {
            $.info(`[${proxy.name}] 设置失败缓存`);
            cache.set(id, {}); // 设置失败缓存
          }
        }
      }
      $.log(`[${proxy.name}] api: ${JSON.stringify(api, null, 2)}`); // 记录 API 响应
    } catch (e) {
      $.error(`[${proxy.name}] ${e.message ?? e}`); // 记录错误
      if (cacheEnabled) {
        $.info(`[${proxy.name}] 设置失败缓存`);
        cache.set(id, {}); // 设置失败缓存
      }
    }
  }

  // HTTP 请求
  async function http(opt = {}) {
    const METHOD = opt.method || 'get'; // 请求方法
    const TIMEOUT = parseFloat(opt.timeout || $arguments.timeout || 5000); // 请求超时时间
    const RETRIES = parseFloat(opt.retries ?? $arguments.retries ?? 1); // 重试次数
    const RETRY_DELAY = parseFloat(opt.retry_delay ?? $arguments.retry_delay ?? 1000); // 重试延时

    let count = 0;
    const fn = async () => {
      try {
        return await $.http[METHOD]({ ...opt, timeout: TIMEOUT }); // 发起 HTTP 请求
      } catch (e) {
        if (count < RETRIES) {
          count++;
          const delay = RETRY_DELAY * count; // 计算重试延时
          await $.wait(delay); // 等待延时
          return await fn(); // 重试请求
        } else {
          throw e; // 抛出错误
        }
      }
    };
    return await fn(); // 执行请求
  }

  // 从对象中获取指定路径的值
  function lodash_get(source, path, defaultValue = undefined) {
    const paths = path.replace(/\[(\d+)\]/g, '.$1').split('.'); // 将路径转换为数组
    let result = source;
    for (const p of paths) {
      result = Object(result)[p]; // 逐级获取属性值
      if (result === undefined) {
        return defaultValue; // 如果未找到，返回默认值
      }
    }
    return result; // 返回找到的值
  }

  // 格式化字符串
  function formatter({ proxy = {}, api = {}, format = '' }) {
    let f = format.replace(/\{\{(.*?)\}\}/g, '${$1}'); // 替换 {{}} 为模板字符串
    return eval(`\`${f}\``); // 执行模板字符串
  }

  // 并发执行任务
  function executeAsyncTasks(tasks, { wrap, result, concurrency = 1 } = {}) {
    return new Promise(async (resolve, reject) => {
      try {
        let running = 0; // 当前正在运行的任务数
        const results = []; // 任务结果
        let index = 0; // 任务索引

        function executeNextTask() {
          while (index < tasks.length && running < concurrency) {
            const taskIndex = index++; // 获取当前任务索引
            const currentTask = tasks[taskIndex]; // 获取当前任务
            running++; // 增加正在运行的任务数

            currentTask()
              .then(data => {
                if (result) {
                  results[taskIndex] = wrap ? { data } : data; // 存储任务结果
                }
              })
              .catch(error => {
                if (result) {
                  results[taskIndex] = wrap ? { error } : error; // 存储任务错误
                }
              })
              .finally(() => {
                running--; // 减少正在运行的任务数
                executeNextTask(); // 执行下一个任务
              });
          }

          if (running === 0) {
            return resolve(result ? results : undefined); // 所有任务完成后返回结果
          }
        }

        await executeNextTask(); // 开始执行任务
      } catch (e) {
        reject(e); // 捕获错误
      }
    });
  }
}
