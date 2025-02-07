
/**
 * 节点信息(入口版)
 *
 * ⚠️ 本脚本不进行域名解析 如有需要 可在节点操作中添加域名解析
 *
 * 查看说明: https://t.me/zhetengsha/1358
 *
 * 落地版脚本请查看: https://t.me/zhetengsha/1269
 *
 * 欢迎加入 Telegram 群组 https://t.me/zhetengsha
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
 * - [format] 自定义格式, 从 节点(proxy) 和 入口(api)中取数据. 默认为: {{api.country}} {{api.city}}
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
  const $=$substore
  const internal = $arguments.internal
  const format = `{{api.country}}-{{api.city}}` // 自定义格式为 国家-城市
  const valid = `ProxyUtils.isIP('{{api.ip || api.query}}')`
  const ignore_failed_error = $arguments.ignore_failed_error
  const remove_failed = $arguments.remove_failed
  const entranceEnabled = $arguments.entrance
  const cacheEnabled = $arguments.cache
  const uniq_key = $arguments.uniq_key || '^server$'
  const cache = scriptResourceCache
  const method = $arguments.method || 'get'
  const url = $arguments.api || `http://ip-api.com/json/{{proxy.server}}?lang=zh-CN`
  const concurrency = parseInt($arguments.concurrency || 10) // 一组并发数

  await executeAsyncTasks(
    proxies.map(proxy => () => check(proxy)),
    { concurrency }
  )

  if (remove_failed) {
    proxies = proxies.filter(p => p._entrance)
  }

  if (!entranceEnabled) {
    proxies = proxies.map(p => ({ ...p, _entrance: undefined }))
  }

  return proxies

  async function check(proxy) {
    const id = cacheEnabled ? `entrance:${url}:${format}:${internal}:${JSON.stringify(proxy)}` : undefined
    try {
      const cached = cache.get(id)
      if (cacheEnabled && cached) {
        if (cached.api) {
          proxy.name = formatter({ proxy, api: cached.api, format })
          proxy._entrance = cached.api
          return
        } else if (!ignore_failed_error) {
          return
        }
      }
      let api = {}
      if (internal) {
        api = {
          countryCode: utils.geoip(proxy.server) || '',
          aso: utils.ipaso(proxy.server) || '',
        }
        if ((api.countryCode || api.aso) && eval(formatter({ api, format: valid }))) {
          proxy.name = formatter({ proxy, api, format })
          proxy._entrance = api
          if (cacheEnabled) {
            cache.set(id, { api })
          }
        } else if (cacheEnabled) {
          cache.set(id, {})
        }
      } else {
        const res = await http({ method, url: formatter({ proxy, format: url }) })
        api = JSON.parse(res.body)
        if (res.status == 200 && eval(formatter({ api, format: valid }))) {
          proxy.name = formatter({ proxy, api, format })
          proxy._entrance = api
          if (cacheEnabled) {
            cache.set(id, { api })
          }
        } else if (cacheEnabled) {
          cache.set(id, {})
        }
      }
    } catch (e) {
      if (cacheEnabled) {
        cache.set(id, {})
      }
    }
  }

  async function http(opt = {}) {
    const TIMEOUT = parseFloat(opt.timeout || $arguments.timeout || 5000)
    const RETRIES = parseFloat(opt.retries ?? $arguments.retries ?? 1)
    const RETRY_DELAY = parseFloat(opt.retry_delay ?? $arguments.retry_delay ?? 1000)

    let count = 0
    const fn = async () => {
      try {
        return await $.http[opt.method || 'get']({ ...opt, timeout: TIMEOUT })
      } catch (e) {
        if (count < RETRIES) {
          count++
          await $.wait(RETRY_DELAY * count)
          return await fn()
        } else {
          throw e
        }
      }
    }
    return await fn()
  }

  function formatter({ proxy = {}, api = {}, format = '' }) {
    let f = format.replace(/\{\{(.*?)\}\}/g, '${$1}')
    return eval(`\`${f}\``)
  }

  function executeAsyncTasks(tasks, { concurrency = 1 } = {}) {
    return new Promise(async (resolve) => {
      let running = 0
      let index = 0

      function executeNextTask() {
        while (index < tasks.length && running < concurrency) {
          running++
          tasks[index++]().finally(() => {
            running--
            executeNextTask()
          })
        }
        if (running === 0) resolve()
      }

      executeNextTask()
    })
  }
}

