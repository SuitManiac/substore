async function operator(proxies = [], targetPlatform, context) {
  const $ = $substore;
  const { isLoon, isSurge, isNode } = $.env;
  const internal = $arguments.internal;
  const format = $arguments.format || (internal ? '{{api.countryCode}} {{api.aso}} - {{proxy.name}}' : '{{api.country}} {{api.isp}} - {{proxy.name}}');
  const url = $arguments.api || (internal ? 'http://checkip.amazonaws.com' : 'http://ip-api.com/json?lang=zh-CN');
  const surge_http_api = $arguments.surge_http_api;
  const surge_http_api_protocol = $arguments.surge_http_api_protocol || 'http';
  const surge_http_api_key = $arguments.surge_http_api_key;
  const surge_http_api_enabled = !!surge_http_api;
  const ignore_failed_error = $arguments.ignore_failed_error;
  const remove_failed = $arguments.remove_failed;
  const remove_incompatible = $arguments.remove_incompatible;
  const incompatibleEnabled = $arguments.incompatible;
  const geoEnabled = $arguments.geo;
  const cacheEnabled = $arguments.cache;
  const cache = scriptResourceCache;
  const method = $arguments.method || 'get';
  const concurrency = parseInt($arguments.concurrency || 10);

  if (!surge_http_api_enabled && !isLoon && !isSurge) {
    throw new Error('请使用 Loon, Surge(ability=http-client-policy) 或 配置 HTTP API');
  }

  if (internal && (typeof $utils === 'undefined' || typeof $utils.geoip === 'undefined' || typeof $utils.ipaso === 'undefined')) {
    $.error(`目前仅支持 Surge/Loon(build >= 692) 等有 $utils.ipaso 和 $utils.geoip API 的 App`);
    throw new Error('不支持使用内部方法获取 IP 信息, 请查看日志');
  }

  await executeAsyncTasks(proxies.map(proxy => () => checkProxy(proxy)), { concurrency });

  if (remove_incompatible || remove_failed) {
    proxies = proxies.filter(p => !(remove_incompatible && p._incompatible) && !(remove_failed && !p._geo));
  }

  if (!geoEnabled || !incompatibleEnabled) {
    proxies = proxies.map(p => {
      if (!geoEnabled) delete p._geo;
      if (!incompatibleEnabled) delete p._incompatible;
      return p;
    });
  }

  return proxies;

  async function checkProxy(proxy) {
    const id = cacheEnabled ? `geo:${url}:${format}:${internal}:${JSON.stringify(
      Object.fromEntries(Object.entries(proxy).filter(([key]) => !/^(collectionName|subName|id|_.*)$/i.test(key)))
    )}` : undefined;

    try {
      const node = ProxyUtils.produce([proxy], surge_http_api_enabled ? 'Surge' : targetPlatform);
      if (!node) {
        proxy._incompatible = true;
        return;
      }

      const cached = cache.get(id);
      if (cacheEnabled && cached) {
        if (cached.api) {
          $.info(`[${proxy.name}] 使用成功缓存`);
          proxy.name = formatName(proxy, cached.api, format);
          proxy._geo = cached.api;
          return;
        } else if (!ignore_failed_error) {
          $.info(`[${proxy.name}] 使用失败缓存`);
          return;
        }
      }

      const startedAt = Date.now();
      const res = await httpRequest({ method, url, 'policy-descriptor': node, node });
      const api = internal ? parseInternalResponse(res.body) : parseExternalResponse(res.body);

      if (res.status === 200) {
        proxy.name = formatName(proxy, api, format);
        proxy._geo = api;
        if (cacheEnabled) {
          $.info(`[${proxy.name}] 设置成功缓存`);
          cache.set(id, { api });
        }
      } else if (cacheEnabled) {
        $.info(`[${proxy.name}] 设置失败缓存`);
        cache.set(id, {});
      }
    } catch (e) {
      $.error(`[${proxy.name}] ${e.message ?? e}`);
      if (cacheEnabled) {
        $.info(`[${proxy.name}] 设置失败缓存`);
        cache.set(id, {});
      }
    }
  }

  async function httpRequest(opt = {}) {
    const METHOD = opt.method || 'get';
    const TIMEOUT = parseFloat(opt.timeout || $arguments.timeout || 5000);
    const RETRIES = parseFloat(opt.retries ?? $arguments.retries ?? 1);
    const RETRY_DELAY = parseFloat(opt.retry_delay ?? $arguments.retry_delay ?? 1000);

    let count = 0;
    const request = async () => {
      try {
        if (surge_http_api_enabled) {
          const res = await $.http.post({
            url: `${surge_http_api_protocol}://${surge_http_api}/v1/scripting/evaluate`,
            timeout: TIMEOUT,
            headers: { 'x-key': surge_http_api_key, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              script_text: `$httpClient.get(${JSON.stringify({
                ...opt,
                timeout: TIMEOUT / 1000,
              })}, (error, response, data) => {  $done({ error, response, data }) }) `,
              mock_type: 'cron',
              timeout: TIMEOUT / 1000,
            }),
          });
          const body = JSON.parse(res.body);
          if (body.result.error) throw new Error(body.result.error);
          return { ...body.result.response, body: body.result.data };
        } else {
          return await $.http[METHOD]({ ...opt, timeout: TIMEOUT });
        }
      } catch (e) {
        if (count < RETRIES) {
          count++;
          await $.wait(RETRY_DELAY * count);
          return request();
        } else {
          throw e;
        }
      }
    };
    return await request();
  }

  function parseInternalResponse(body) {
    const ip = body.trim();
    return {
      countryCode: $utils.geoip(ip) || '',
      aso: $utils.ipaso(ip) || '',
      asn: $utils.ipasn(ip) || '',
    };
  }

  function parseExternalResponse(body) {
    try {
      return JSON.parse(body);
    } catch (e) {
      return body;
    }
  }

  function formatName(proxy, api, format) {
    return format.replace(/\{\{(.*?)\}\}/g, (_, key) => eval(`proxy.${key}`) || eval(`api.${key}`) || '');
  }

  async function executeAsyncTasks(tasks, { concurrency = 1 } = {}) {
    const results = [];
    for (let i = 0; i < tasks.length; i += concurrency) {
      const batch = tasks.slice(i, i + concurrency);
      results.push(...await Promise.all(batch.map(task => task())));
    }
    return results;
  }
}
