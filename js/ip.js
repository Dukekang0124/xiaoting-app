// 墨小溟 · IP 形象（云朵水母）生命感系统 v1.2
// v1.1 重塑：半透明发光身体 + 波浪裙摆 + 垂须 + 温柔大眼 + 内部流动微光
// v1.2 生命感：新增 empathy_tears（共情落泪）/ tender（温柔凝视）两状态；
//        微动作：倾听点头 + 实时音量驱动触角（--ip-vol）+ 担心皱眉 + 开心星光；
//        呼吸引导环（录音停顿>3s）+ 防呆气泡（等待>10s）由 body 类联动。
// 状态：idle / listening / thinking / empathy / empathy_tears / tender / happy / worried
//      —— 由 CSS class 驱动，SVG 结构恒定（新增 brow/tears/spark/breath 四组默认隐藏元素）。
//
// 设计约束（来自《UI 视觉精装修指令 v1.1》§1）：
//   一团柔软、半透明、会发光的云朵水母状小生物；没有明确嘴巴；两只温柔的大眼睛（不要太大太圆，要有"安静"感）；
//   身体内部有流动的微光；头顶两根小天线；身体半透明柔和紫 #B8A9E8；内部微光 #FFB88C / #A8C8E8。
//
// 实现要点：
//   * 颜色全部走 CSS 变量（--ip-*），状态切换只换变量 + 挂动画，SVG 结构零变化 ⇒ 加状态不用改 JS。
//   * 身体用带 alpha 的 radialGradient（不是实心），内部微光画在身体之上并用 screen 混合 ⇒ 真正"透出来"。
//   * 眼睛加"上眼睑柔光层"（lid）压住瞳孔上缘 + 外眼角微垂 5° ⇒ 读作安静而不是警觉。
//   * 双高光（大左上 + 小右下）与湿层（wet）分别给"有神"和"湿润"。
//   * brow/tears/spark/breath 四组元素默认 opacity:0，只在对应状态/身体类下浮现，结构零侵入。

let seq = 0;

/**
 * 渲染墨小溟 IP。
 * @param {'idle'|'listening'|'thinking'|'empathy'|'empathy_tears'|'tender'|'happy'|'worried'} state
 * @param {number} size 边长（px）
 * @returns {string} SVG 字符串
 */
export function mascot(state = 'idle', size = 180) {
  const uid = 'm' + (++seq);
  return `
<svg class="mascot mascot--${state}" width="${size}" height="${size}" viewBox="0 0 200 200"
     role="img" aria-label="墨小溟（${state}）" data-state="${state}" data-ip="v1.2">
  <defs>
    <radialGradient id="body-${uid}" cx="46%" cy="30%" r="80%">
      <stop offset="0%"   stop-color="var(--ip-body-in)"  stop-opacity=".92"/>
      <stop offset="56%"  stop-color="var(--ip-body-mid)" stop-opacity=".64"/>
      <stop offset="100%" stop-color="var(--ip-body-out)" stop-opacity=".42"/>
    </radialGradient>
    <radialGradient id="halo-${uid}" cx="50%" cy="50%" r="50%">
      <stop offset="0%"   stop-color="var(--ip-halo)" stop-opacity=".72"/>
      <stop offset="55%"  stop-color="var(--ip-halo)" stop-opacity=".24"/>
      <stop offset="100%" stop-color="var(--ip-halo)" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="core-${uid}" cx="50%" cy="50%" r="50%">
      <stop offset="0%"   stop-color="var(--ip-glow)"   stop-opacity=".80"/>
      <stop offset="52%"  stop-color="var(--ip-glow-2)" stop-opacity=".34"/>
      <stop offset="100%" stop-color="var(--ip-glow-2)" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="eye-${uid}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%"   stop-color="var(--ip-eye-top)"/>
      <stop offset="100%" stop-color="var(--ip-eye)"/>
    </linearGradient>
    <!-- 垂须：由粗到细淡出，避免读成"昆虫腿" -->
    <linearGradient id="wisp-${uid}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%"   stop-color="var(--ip-antenna)" stop-opacity=".52"/>
      <stop offset="70%"  stop-color="var(--ip-antenna)" stop-opacity=".22"/>
      <stop offset="100%" stop-color="var(--ip-antenna)" stop-opacity="0"/>
    </linearGradient>
  </defs>

  <!-- 外光晕 -->
  <circle class="mascot__halo" cx="100" cy="102" r="90" fill="url(#halo-${uid})"/>

  <!-- 呼吸引导环：录音停顿>3s 时出现，缓慢张缩引导用户呼吸（默认隐藏） -->
  <circle class="mascot__breath" cx="100" cy="102" r="86" fill="none" stroke="var(--ip-halo)" stroke-width="2.4" opacity="0"/>

  <!-- 头顶触角（两根小天线）。每根单独成组 ⇒ 触角与末端光点一起动，且左右可反向摆动 -->
  <g class="mascot__antennae">
    <g class="ant ant--l">
      <path class="mascot__antenna" d="M82 52 C69 34 71 21 80 13"
            fill="none" stroke="var(--ip-antenna)" stroke-width="3" stroke-linecap="round"/>
      <circle class="mascot__tip-glow" cx="80" cy="12" r="10" fill="var(--ip-tip)" opacity=".20"/>
      <circle class="mascot__tip" cx="80" cy="12" r="4.4" fill="var(--ip-tip)"/>
    </g>
    <g class="ant ant--r">
      <path class="mascot__antenna" d="M118 52 C131 34 129 21 120 13"
            fill="none" stroke="var(--ip-antenna)" stroke-width="3" stroke-linecap="round"/>
      <circle class="mascot__tip-glow" cx="120" cy="12" r="10" fill="var(--ip-tip)" opacity=".20"/>
      <circle class="mascot__tip" cx="120" cy="12" r="4.4" fill="var(--ip-tip)"/>
    </g>
  </g>

  <g class="mascot__body">
    <!-- 体内核心光（在身体之下，靠身体半透明透出来） -->
    <ellipse class="mascot__core" cx="100" cy="106" rx="52" ry="48" fill="url(#core-${uid})"/>

    <!-- 垂须（水母感）：短、柔、向下淡出；小尺寸自然隐去 -->
    <g class="mascot__wisps">
      <path class="mascot__wisp wisp--1" d="M80 138 C75 148 76 156 81 160"
            fill="none" stroke="url(#wisp-${uid})" stroke-width="3.2" stroke-linecap="round"/>
      <path class="mascot__wisp wisp--2" d="M100 142 C100 152 101 159 104 163"
            fill="none" stroke="url(#wisp-${uid})" stroke-width="3.2" stroke-linecap="round"/>
      <path class="mascot__wisp wisp--3" d="M120 138 C125 148 124 156 119 160"
            fill="none" stroke="url(#wisp-${uid})" stroke-width="3.2" stroke-linecap="round"/>
    </g>

    <!-- 云朵水母身体：圆顶 + 浅波浪裙摆 -->
    <path class="mascot__blob"
      d="M100 26 C142 26 166 56 164 92
         C163 104 158 114 150 121 C152 130 147 138 138 137
         C134 145 126 147 120 142 C113 149 105 149 100 145
         C95 149 87 149 80 142 C74 147 66 145 62 137
         C53 138 48 130 50 121 C42 114 37 104 36 92
         C34 56 58 26 100 26 Z"
      fill="url(#body-${uid})"/>

    <!-- 左上柔光（体积感） -->
    <ellipse class="mascot__sheen" cx="72" cy="60" rx="23" ry="14"
             fill="#ffffff" opacity=".34" transform="rotate(-24 72 60)"/>

    <!-- 体内流动微光（screen 混合 ⇒ 像从身体里透出来） -->
    <g class="mascot__glows" style="mix-blend-mode:screen">
      <circle class="glow glow--1" cx="76"  cy="116" r="7.4" fill="var(--ip-glow)"   opacity=".72"/>
      <circle class="glow glow--2" cx="110" cy="128" r="5.6" fill="var(--ip-glow-2)" opacity=".66"/>
      <circle class="glow glow--3" cx="127" cy="109" r="6.2" fill="var(--ip-glow)"   opacity=".58"/>
      <circle class="glow glow--4" cx="92"  cy="134" r="3.8" fill="var(--ip-glow-2)" opacity=".55"/>
    </g>

    <!-- 眼睛：温柔大眼 + 上眼睑柔光 + 双高光（无嘴巴） -->
    <g class="mascot__eyes">
      <g class="eye-wrap eye-wrap--l" transform="rotate(-5 82 101)">
        <ellipse class="eye" cx="82" cy="101" rx="10.8" ry="12.8" fill="url(#eye-${uid})"/>
        <ellipse class="lid" cx="82" cy="90.6" rx="10.8" ry="6.4" fill="var(--ip-body-in)" opacity=".38"/>
        <circle class="shine"  cx="78.1" cy="95.9" r="3.6" fill="#ffffff" opacity=".95"/>
        <circle class="shine2" cx="85.6" cy="106.6" r="1.7" fill="#ffffff" opacity=".48"/>
        <ellipse class="wet" cx="82" cy="110.4" rx="7.8" ry="2.6" fill="var(--ip-wet)" opacity="0"/>
      </g>
      <g class="eye-wrap eye-wrap--r" transform="rotate(5 118 101)">
        <ellipse class="eye" cx="118" cy="101" rx="10.8" ry="12.8" fill="url(#eye-${uid})"/>
        <ellipse class="lid" cx="118" cy="90.6" rx="10.8" ry="6.4" fill="var(--ip-body-in)" opacity=".38"/>
        <circle class="shine"  cx="114.1" cy="95.9" r="3.6" fill="#ffffff" opacity=".95"/>
        <circle class="shine2" cx="121.6" cy="106.6" r="1.7" fill="#ffffff" opacity=".48"/>
        <ellipse class="wet" cx="118" cy="110.4" rx="7.8" ry="2.6" fill="var(--ip-wet)" opacity="0"/>
      </g>
    </g>

    <!-- 眉毛：担心时浮现并皱起（默认隐藏） -->
    <g class="mascot__brow">
      <path class="brow brow--l" d="M73 89 Q82 83 91 88" fill="none" stroke="var(--ip-eye)" stroke-width="3" stroke-linecap="round"/>
      <path class="brow brow--r" d="M109 88 Q118 83 127 89" fill="none" stroke="var(--ip-eye)" stroke-width="3" stroke-linecap="round"/>
    </g>

    <!-- 泪滴：共情落泪时浮现并滑落（默认隐藏） -->
    <g class="mascot__tears">
      <path class="tear tear--l" d="M82 117 C78.5 124 78.5 130 82 132 C85.5 130 85.5 124 82 117 Z" fill="var(--ip-wet)" opacity=".9"/>
      <path class="tear tear--r" d="M118 117 C114.5 124 114.5 130 118 132 C121.5 130 121.5 124 118 117 Z" fill="var(--ip-wet)" opacity=".9"/>
    </g>

    <!-- 腮红：共情 / 开心才浮现 -->
    <g class="mascot__blush">
      <ellipse class="blush" cx="61"  cy="117" rx="9.4" ry="6" fill="var(--ip-blush)" opacity="0"/>
      <ellipse class="blush" cx="139" cy="117" rx="9.4" ry="6" fill="var(--ip-blush)" opacity="0"/>
    </g>
  </g>

  <!-- 星光：开心鼓励时浮现（默认隐藏） -->
  <g class="mascot__spark">
    <path class="spark spark--1" d="M62 13 L64 18 L69 20 L64 22 L62 27 L60 22 L55 20 L60 18 Z" fill="var(--ip-tip)" opacity=".9"/>
    <path class="spark spark--2" d="M138 15 L140 20 L145 22 L140 24 L138 29 L136 24 L131 22 L136 20 Z" fill="var(--ip-tip)" opacity=".9"/>
    <path class="spark spark--3" d="M100 3 L101.5 6.5 L105 8 L101.5 9.5 L100 13 L98.5 9.5 L95 8 L98.5 6.5 Z" fill="var(--ip-tip)" opacity=".9"/>
  </g>
</svg>`;
}

/**
 * 列表 / 小尺寸用的圆形头像（我的页顶部、卡片角标）。
 * 带柔和底色，避免小尺寸下细节糊成一团。
 */
export function avatar(state = 'idle', size = 44) {
  return `<span class="avatar avatar--${state}" style="width:${size}px;height:${size}px">${mascot(state, Math.round(size * 1.02))}</span>`;
}

/** 只渲染一只小表情（卡片角标用） */
export function miniFace(state = 'happy', size = 26) {
  return `<span class="miniface miniface--${state}" style="width:${size}px;height:${size}px" aria-hidden="true">${mascot(state, size)}</span>`;
}
