// 墨小溟 · CF 网关模型配置（移植自 server/llm.config.json，v1.7.6 实测全量重排）
//
// 与本地版的唯一差异：密钥不再走 keysFile / keysEnv(JSON)，改为每个 provider 一个 env 变量名（keyEnv），
// 由 Cloudflare Secrets 注入（env[keyEnv]）。workbuddy 网关用可公开的 publishableKey，无密钥。
// 结构（优先级 / 超时 / 降级 / 重试 / 场景档位）完全照搬，确保线上行为与本地一致。
//
// 2026-10-03 v1.7.6 全量重排依据 = 产品真实 Prompt 实测，不是拍脑袋：
//   候选四档（用户指定顺序）：GLM-5.3-Flash → deepseek-v4-flash → agnes-2.5-flash → GLM-4-Flash
//   实测（主分析 Prompt，1200 max_tokens）：
//     glm-5.3-flash            不传 reasoning_effort ⇒ 26.8s 且正文 0 字符；传 low ⇒ 10.9s 合法 JSON
//     deepseek-v4-flash        3.7s 合法 JSON（云网关）/ 7.1s（OpenRouter）
//     agnes-2.5-flash         11.6s 合法 JSON
//     glm-4-flash             19.3s 合法 JSON（智谱）
//   ⇒ glm-5.3-flash 两个入口都必须带 params.reasoning_effort='low'。

export const CONFIG = {
  version: 2,

  defaults: {
    timeoutMs: 12000,
    attempts: 2,
    backoffMs: 250,
    temperature: 0.3,
    maxInputChars: 4000,
  },

  providers: {
    // 档位 1 / 2 的 OpenRouter 路由（同把 key 覆盖两个模型）
    openrouter: {
      label: 'OpenRouter 聚合网关',
      kind: 'openai-compatible',
      endpoint: 'https://openrouter.ai/api/v1/chat/completions',
      authHeader: 'Authorization',
      authPrefix: 'Bearer ',
      keyEnv: 'OPENROUTER_KEY',
      timeoutMs: 20000,
      models: {
        'z-ai/glm-5.3-flash': {
          keyRef: 'openrouter',
          enabled: true,
          timeoutMs: 20000,
          attempts: 1,
          params: { reasoning_effort: 'low' },
          note: '档位 1 的 OpenRouter 路由。params 必须有：不传 reasoning_effort 会把 token 全花在思考上，正文为空。',
        },
        'deepseek/deepseek-v4-flash': {
          keyRef: 'openrouter',
          enabled: true,
          timeoutMs: 20000,
          attempts: 1,
          note: '档位 2 的 OpenRouter 路由（云网关那条更快，所以网关在前、这条做备用路由）。',
        },
      },
    },

    // 档位 3
    agnes: {
      label: 'Agnes AI',
      kind: 'openai-compatible',
      endpoint: 'https://apihub.agnes-ai.cn/v1/chat/completions',
      authHeader: 'Authorization',
      authPrefix: 'Bearer ',
      keyEnv: 'AGNES_KEY',
      timeoutMs: 20000,
      models: {
        'agnes-2.5-flash': {
          keyRef: 'agnes',
          enabled: true,
          timeoutMs: 20000,
          attempts: 1,
          note: '档位 3。512K 上下文、OpenAI 兼容。注意：国内站 apihub.agnes-ai.cn/v1 才通，api.agnes-ai.cn 对同一把 key 回 401。',
        },
      },
    },

    // 免密钥兜底网关（前端 js/llm.js 的线上主链也用它，前后端可同源）
    workbuddy: {
      label: 'WorkBuddy 云服务免密钥网关',
      kind: 'workbuddy-gateway',
      endpoint: 'https://xiaoting.app.workbuddy.host',
      path: '/.cloud/llm/chat/completions',
      publishableKey: 'wbpk_UIbhopeTjkEWVQhMQ0Q0Ia_qOJRuVD4iBCKnctk4ks1e7G1YT9H3NWS',
      authHeader: 'x-wb-webapp-access-key',
      authPrefix: '',
      timeoutMs: 20000,
      streamOnly: true,
      models: {
        'glm-5.3-flash': {
          enabled: true,
          timeoutMs: 20000,
          attempts: 1,
          params: { reasoning_effort: 'low' },
          note: '档位 1 的云网关路由。免密钥。params 必需，理由同 OpenRouter 那条。',
        },
        'deepseek-v4-flash': {
          enabled: true,
          timeoutMs: 12000,
          attempts: 1,
          note: '档位 2 主路由。全链最快，排 OpenRouter 那条前面。',
        },
        'deepseek-v4.1-flash': {
          enabled: true,
          timeoutMs: 12000,
          attempts: 1,
          note: 'v1.7.3~v1.7.5 时期线上主力。仍可用，保留为网关内兜底。',
        },
        'hunyuan-chat': {
          enabled: true,
          note: '备用项（不在任何默认链里）。',
        },
      },
    },

    // 档位 4 = 用户指定的兜底，唯一「换 key 就能直连」的厂商通道
    zhipu: {
      label: '智谱直连',
      kind: 'openai-compatible',
      endpoint: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
      authHeader: 'Authorization',
      authPrefix: 'Bearer ',
      keyEnv: 'ZHIPU_KEY',
      timeoutMs: 25000,
      models: {
        'glm-4-flash': {
          keyRef: 'glm-4-flash',
          enabled: true,
          timeoutMs: 25000,
          attempts: 1,
          note: '档位 4 兜底。实测 990ms(短请求) / 2.2s(safety) / 19.3s(main) 出合法 JSON。',
        },
      },
    },
  },

  tiers: {
    default: [
      'openrouter:z-ai/glm-5.3-flash',
      'workbuddy:glm-5.3-flash',
      'workbuddy:deepseek-v4-flash',
      'openrouter:deepseek/deepseek-v4-flash',
      'agnes:agnes-2.5-flash',
      'zhipu:glm-4-flash',
    ],
  },

  modules: {
    safety: {
      tier: ['openrouter:z-ai/glm-5.3-flash', 'workbuddy:glm-5.3-flash', 'workbuddy:deepseek-v4-flash', 'openrouter:deepseek/deepseek-v4-flash', 'agnes:agnes-2.5-flash', 'zhipu:glm-4-flash'],
      timeoutMs: 9000,
      temperature: 0,
      attempts: 1,
      note: '安全识别：快 + 高召回，失败必须保守兜底。',
    },
    analysis: {
      tier: ['openrouter:z-ai/glm-5.3-flash', 'workbuddy:glm-5.3-flash', 'workbuddy:deepseek-v4-flash', 'openrouter:deepseek/deepseek-v4-flash', 'agnes:agnes-2.5-flash', 'zhipu:glm-4-flash'],
      temperature: 0.3,
      note: '主分析：不设模块级 timeoutMs，让每个模型走自己的超时。',
    },
    followup: {
      tier: ['openrouter:z-ai/glm-5.3-flash', 'workbuddy:glm-5.3-flash', 'workbuddy:deepseek-v4-flash', 'openrouter:deepseek/deepseek-v4-flash', 'agnes:agnes-2.5-flash', 'zhipu:glm-4-flash'],
      temperature: 0.5,
      note: '追问质量命门，与主分析同源优先序。',
    },
    card: {
      tier: ['openrouter:z-ai/glm-5.3-flash', 'workbuddy:glm-5.3-flash', 'workbuddy:deepseek-v4-flash', 'openrouter:deepseek/deepseek-v4-flash', 'agnes:agnes-2.5-flash', 'zhipu:glm-4-flash'],
      temperature: 0.4,
    },
    timeline: {
      tier: ['openrouter:z-ai/glm-5.3-flash', 'workbuddy:glm-5.3-flash', 'workbuddy:deepseek-v4-flash', 'openrouter:deepseek/deepseek-v4-flash', 'agnes:agnes-2.5-flash', 'zhipu:glm-4-flash'],
      temperature: 0.4,
      timeoutMs: 25000,
    },
    weekly: {
      tier: ['openrouter:z-ai/glm-5.3-flash', 'workbuddy:glm-5.3-flash', 'workbuddy:deepseek-v4-flash', 'openrouter:deepseek/deepseek-v4-flash', 'agnes:agnes-2.5-flash', 'zhipu:glm-4-flash'],
      temperature: 0.4,
      timeoutMs: 30000,
    },
    // 🔴 场景分流「轻交互」档位：以最快的 deepseek-v4-flash 打头，跳过思考型 glm-5.3-flash。
    // 留给「IP 点击轻互动接入模型」时使用（前端当前未接，属待命档位，不会凭空被调用）。
    light: {
      tier: ['workbuddy:deepseek-v4-flash', 'openrouter:deepseek/deepseek-v4-flash', 'agnes:agnes-2.5-flash', 'zhipu:glm-4-flash'],
      temperature: 0.5,
      note: '轻交互档位：以最快的 deepseek-v4-flash 打头，跳过思考型 glm-5.3-flash。',
    },
    asr_cleanup: {
      tier: ['zhipu:glm-4-flash'],
      enabled: false,
      temperature: 0,
      timeoutMs: 4000,
      note: '可选：识别结果顺句/纠错。默认关闭（情绪产品用户原话本身就是证据，改写有风险）。',
    },
  },

  degradeOn: {
    codes: [
      'http_400', 'http_401', 'http_403', 'http_404', 'http_408', 'http_409',
      'http_429', 'http_5xx', 'network', 'timeout', 'abort',
      'model_not_found', 'no_key', 'quota_exhausted', 'rate_limited',
      'empty_response', 'json_parse_failed', 'reasoning_only', 'output_truncated',
      'unsupported_parameter',
    ],
  },

  retry: {
    perModel: 2,
    onlyCodes: ['http_429', 'http_5xx', 'network', 'timeout', 'abort', 'rate_limited'],
    backoffMs: 250,
    note: '只对瞬时故障在同一模型上重试；参数类错误直接换档。默认链里各模型显式 attempts:1，宁可立刻换路由。',
  },

  logging: {
    logRawText: false,
    note: 'CF 下不落盘：内存统计 + console.log 元数据（不含正文、不含 key）。',
  },
};
