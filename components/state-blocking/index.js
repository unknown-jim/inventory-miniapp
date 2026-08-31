// 全局阻断态卡片。稿 Row/00「全局阻断态（4 种）」= 4:1099 下的四个本体：
//   state/blocking/maintenance 4:1100 · migrating 4:1104
//   state/blocking/outdated    4:1107 · no-shop   4:1110
// 四种只差「图标字形 + 图标配色 + 有没有按钮」，卡片结构逐格相同，
// 所以是一个组件 + 一张表，不是四个组件。
//
// **文案不在这里。** title / body / action 由调用页从 utils/messages.js 的
// blockingFor() 取 —— docs/ui-scale.md「错误文案走 utils/messages.js，
// 不要在页面里自己写」，那条规矩同样管组件。
//
// **不要加 virtualHost。** 开了页面侧就没有宿主节点，automator 的
// page.$$ / >>> / selectComponent 全查不到卡片里的标题和按钮；
// components/record-sheet 和 components/slip-overlay 都为此摘掉过，
// 理由抄在那两个文件顶部。宿主是块级空节点，卡片本身占流，不影响排版。
// tests/ui-scale.test.js 有一条静态钉子拦这件事。

// 字形一律用文本字符，不引图片：稿上那四个字形本身就是 TEXT 节点
// （7:55 / 7:57 / 7:59 / 7:61），仓库也没有图标体系。
// 配色不在这张表里，走 wxss 的 .sb-icon-<kind>，见 index.wxss。
const GLYPHS = {
  maintenance: '!',
  migrating: '…',
  outdated: '↑',
  'no-shop': '＋',
  generic: '!'
}

Component({
  options: {
    styleIsolation: 'apply-shared'
  },
  properties: {
    // maintenance | migrating | outdated | no-shop | generic
    kind: {
      type: String,
      value: 'generic',
      observer: '_onKind'
    },
    title: { type: String, value: '' },
    body: { type: String, value: '' },
    // 空串 = 不给按钮。稿上只有 no-shop 带 CTA；generic 也给，理由见规格 4.4。
    action: { type: String, value: '' }
  },
  data: {
    // 默认值 = GLYPHS.generic。observer 万一没跑，渲染出来的也是兜底档，不是空白。
    glyph: '!'
  },
  methods: {
    _onKind(kind) {
      this.setData({ glyph: GLYPHS[kind] || GLYPHS.generic })
    },
    onAction() {
      this.triggerEvent('action')
    }
  }
})
