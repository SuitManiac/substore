
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

// 定义一个异步函数 operator，用于处理代理服务器列表，并根据目标平台和上下文进行操作
async function operator(proxies = [], targetPlatform, context) {
  // 获取 $substore 对象
  const $ = $substore
  // 获取当前环境是否为 Node.js
  const { isNode } = $.env
  // 获取内部方法标志
  const internal = $arguments.internal
  // 获取 MMDB 国家数据库文件路径
  const mmdb_country_path = $arguments.mmdb_country_path
  // 获取 MMDB ASN 数据库文件路径
  const mmdb_asn_path = $arguments.mmdb_asn_path
  // 获取有效代理的验证表达式，默认为 IP 验证
  let valid = $arguments.valid || `ProxyUtils.isIP('{{api.ip || api.query}}')`
  // 获取代理格式化字符串，默认为国家和 ISP 信息
  let format = $arguments.format || `{{api.country}} {{api.isp}} - {{proxy.name}}`
  let utils
  // 如果使用内部方法
  if (internal) {
    if (isNode) {
      // 在 Node.js 环境中使用 MMDB 数据库
      utils = new ProxyUtils.MMDB({ country: mmdb_country_path, asn: mmdb_asn_path })
      // 输出 MMDB 数据库文件路径信息
      $.info(
        `[MMDB] GeoLite2 Country 数据库文件路径: ${mmdb_country_path || eval('process.env.SUB_STORE_MMDB_ASN_PATH')}`
      )
      $.info(`[MMDB] GeoLite2 ASN 数据库文件路径: ${mmdb_asn_path || eval('process.env.SUB_STORE_MMDB_COUNTRY_PATH')}`)
    } else {
      // if (isSurge) {
      //   //
      // } else if (isLoon) {
      //   const build = $loon.match(/\((\d+)\)$/)?.[1]
      //   if (build < 692) throw new Error('Loon 版本过低, 请升级到 build 692 及以上版本')
      // } else {
      //   throw new Error('仅 Surge/Loon 支持使用内部方法获取 IP 信息')
      // }
      if (typeof $utils === 'undefined' || typeof $utils.geoip === 'undefined' || typeof $utils.ipaso === 'undefined') {
        $.error(`目前仅支持 Surge/Loon(build >= 692) 等有 $utils.ipaso 和 $utils.geoip API 的 App`)
        throw new Error('不支持使用内部方法获取 IP 信息, 请查看日志')
      }
      utils = $utils
    }
    format = $arguments.format || `{{api.countryCode}} {{api.aso}} - {{proxy.name}}`
    valid = $arguments.valid || `"{{api.countryCode || api.aso}}".length > 0`
  }
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

  // const batches = []
  // for (let i = 0; i < proxies.length; i += concurrency) {
  //   const batch = proxies.slice(i, i + concurrency)
  //   batches.push(batch)
  // }
  // for (const batch of batches) {
  //   await Promise.all(batch.map(check))
  // }

  if (remove_failed) {
    proxies = proxies.filter(p => {
      if (remove_failed && !p._entrance) {
        return false
      }
      return true
    })
  }

  if (!entranceEnabled) {
    proxies = proxies.map(p => {
      if (!entranceEnabled) {
        delete p._entrance
      }
      return p
    })
  }

  return proxies

  async function check(proxy) {
    // $.info(`[${proxy.name}] 检测`)
    // $.info(`检测 ${JSON.stringify(proxy, null, 2)}`)
    const id = cacheEnabled
      ? `entrance:${url}:${format}:${internal}:${JSON.stringify(
          Object.fromEntries(
            Object.entries(proxy).filter(([key]) => {
              const re = new RegExp(uniq_key)
              return re.test(key)
            })
          )
        )}`
      : undefined
    // $.info(`检测 ${id}`)
    try {
      const cached = cache.get(id)
      if (cacheEnabled && cached) {
        if (cached.api) {
          $.info(`[${proxy.name}] 使用成功缓存`)
          $.log(`[${proxy.name}] api: ${JSON.stringify(cached.api, null, 2)}`)
          proxy.name = formatter({ proxy, api: cached.api, format })
          proxy._entrance = cached.api
          return
        } else {
          if (ignore_failed_error) {
            $.info(`[${proxy.name}] 忽略失败缓存`)
          } else {
            $.info(`[${proxy.name}] 使用失败缓存`)
            return
          }
        }
      }
      // 请求
      const startedAt = Date.now()
      let api = {}
      if (internal) {
        api = {
          countryCode: utils.geoip(proxy.server) || '',
          aso: utils.ipaso(proxy.server) || '',
        }
        $.info(`[${proxy.name}] countryCode: ${api.countryCode}, aso: ${api.aso}`)
        if ((api.countryCode || api.aso) && eval(formatter({ api, format: valid }))) {
          proxy.name = formatter({ proxy, api, format })
          proxy._entrance = api
          if (cacheEnabled) {
            $.info(`[${proxy.name}] 设置成功缓存`)
            cache.set(id, { api })
          }
        } else {
          if (cacheEnabled) {
            $.info(`[${proxy.name}] 设置失败缓存`)
            cache.set(id, {})
          }
        }
      } else {
        const res = await http({
          method,
          headers: {
            'User-Agent':
              'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3.1 Mobile/15E148 Safari/604.1',
          },
          url: formatter({ proxy, format: url }),
        })
        api = String(lodash_get(res, 'body'))
        try {
          api = JSON.parse(api)
        } catch (e) {}
        const status = parseInt(res.status || res.statusCode || 200)
        let latency = ''
        latency = `${Date.now() - startedAt}`
        $.info(`[${proxy.name}] status: ${status}, latency: ${latency}`)
        if (status == 200 && eval(formatter({ api, format: valid }))) {
          proxy.name = formatter({ proxy, api, format })
          proxy._entrance = api
          if (cacheEnabled) {
            $.info(`[${proxy.name}] 设置成功缓存`)
            cache.set(id, { api })
          }
        } else {
          if (cacheEnabled) {
            $.info(`[${proxy.name}] 设置失败缓存`)
            cache.set(id, {})
          }
        }
      }
      $.log(`[${proxy.name}] api: ${JSON.stringify(api, null, 2)}`)
    } catch (e) {
      $.error(`[${proxy.name}] ${e.message ?? e}`)
      if (cacheEnabled) {
        $.info(`[${proxy.name}] 设置失败缓存`)
        cache.set(id, {})
      }
    }
  }
  // 请求
  // 定义一个异步函数http，用于发送HTTP请求，并支持重试机制
  async function http(opt = {}) {
    // 从opt参数中获取请求方法，默认为'get'
    const METHOD = opt.method || 'get'
    // 从opt参数中获取超时时间，默认为5000毫秒
    const TIMEOUT = parseFloat(opt.timeout || $arguments.timeout || 5000)
    // 从opt参数中获取重试次数，默认为1次
    const RETRIES = parseFloat(opt.retries ?? $arguments.retries ?? 1)
    // 从opt参数中获取重试间隔时间，默认为1000毫秒
    const RETRY_DELAY = parseFloat(opt.retry_delay ?? $arguments.retry_delay ?? 1000)

    // 初始化重试计数器
    let count = 0
    // 定义一个内部异步函数fn，用于实际发送请求并处理重试逻辑
    const fn = async () => {
      try {
        // 尝试发送HTTP请求，使用$.http[METHOD]方法，传入opt参数和超时时间
        return await $.http[METHOD]({ ...opt, timeout: TIMEOUT })
      } catch (e) {

        // 如果请求失败，捕获异常
        // $.error(e) // 可选：记录错误信息
        if (count < RETRIES) {

          // 如果当前重试次数小于最大重试次数
          count++ // 增加重试计数
          const delay = RETRY_DELAY * count // 计算当前重试的等待时间
          // $.info(`第 ${count} 次请求失败: ${e.message || e}, 等待 ${delay / 1000}s 后重试`) // 可选：记录重试信息
          await $.wait(delay) // 等待指定的延迟时间
          return await fn() // 递归调用fn函数，进行下一次重试
        } else {
          // 如果已达到最大重试次数，抛出异常
          throw e
        }
      }
    }
    // 调用内部函数fn，并返回结果
    return await fn()
  }
  // 定义一个名为 lodash_get 的函数，用于从对象中按路径获取值
  function lodash_get(source, path, defaultValue = undefined) {
    // 将路径字符串中的数组索引语法（如 [0]）转换为点语法（如 .0），并分割成数组
    const paths = path.replace(/\[(\d+)\]/g, '.$1').split('.')
    // 初始化结果变量为源对象
    let result = source
    // 遍历路径数组
    for (const p of paths) {
      // 尝试从当前结果对象中获取属性 p 的值
      result = Object(result)[p]
      // 如果获取的值为 undefined，则返回默认值
      if (result === undefined) {
        return defaultValue
      }
    }
    // 如果遍历完所有路径，返回最终结果
    return result
  }
  // 定义一个名为formatter的函数，接受一个包含proxy、api和format属性的对象作为参数
  function formatter({ proxy = {}, api = {}, format = '' }) {
    // 使用正则表达式将format字符串中的{{}}替换为${}，以便后续使用模板字符串
    let f = format.replace(/\{\{(.*?)\}\}/g, '${$1}')
    // 使用eval函数执行模板字符串，将proxy和api对象中的属性值插入到模板字符串中
    return eval(`\`${f}\``)
  }
  // 定义一个异步任务执行函数，接受任务数组和一个配置对象作为参数
  function executeAsyncTasks(tasks, { wrap, result, concurrency = 1 } = {}) {
    // 返回一个新的Promise对象
    return new Promise(async (resolve, reject) => {
      try {
        // 初始化正在运行的任务数量
        let running = 0
        // 初始化结果数组
        const results = []

        // 初始化任务索引
        let index = 0

        // 定义一个内部函数，用于执行下一个任务
        function executeNextTask() {
          // 当还有任务未执行且当前运行的任务数量小于并发限制时
          while (index < tasks.length && running < concurrency) {
            // 获取当前任务的索引
            const taskIndex = index++
            // 获取当前任务
            const currentTask = tasks[taskIndex]
            // 增加正在运行的任务数量
            running++

            // 执行当前任务
            currentTask()
              .then(data => {
                // 如果需要结果
                if (result) {
                  // 根据wrap配置决定是否包装结果
                  results[taskIndex] = wrap ? { data } : data
                }
              })
              .catch(error => {
                // 如果需要结果
                if (result) {
                  // 根据wrap配置决定是否包装错误
                  results[taskIndex] = wrap ? { error } : error
                }
              })
              .finally(() => {
                // 减少正在运行的任务数量
                running--
                // 继续执行下一个任务
                executeNextTask()
              })
          }

          // 如果所有任务都执行完毕
          if (running === 0) {
            // 根据result配置决定是否返回结果数组
            return resolve(result ? results : undefined)
          }
        }

        await executeNextTask()
      } catch (e) {
        reject(e)
      }
    })
  }
}

