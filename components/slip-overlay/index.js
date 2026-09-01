Component({
  options: {
    styleIsolation: 'apply-shared'
    // **不要加回 virtualHost**。2026-08-23 到 2026-08-31 它一直开着，代价是
    // 页面侧压根没有本组件的宿主节点：automator 从页面够不到弹层里的任何东西
    //（page.$$('.js-slip')、'slip-overlay >>> .js-slip'、selectComponent 三种写法
    // 实测**全是 0**），于是 tests/ui.test.js 里那条送货单用例只能退化成核对
    // 页面 data 里的 slip 对象 —— 数据对、而组件里字段绑错导致屏幕上不显示，
    // 那版用例查不出来。
    //
    // 摘掉之后页面上有 <slip-overlay id="slip-overlay">，automator 先用
    // page.$('#slip-overlay') 拿到 CustomElement，再在这个实例上查子元素，
    // 后代链就通了（做法和 components/record-sheet 一致）。
    //
    // 排版代价：宿主是块级空节点，弹层本体 .slip-mask 是 position: fixed，
    // 关着的时候 wx:if 连子节点都不渲染，所以宿主高度 0。两个引用点
    //（pages/sale、pages/record-edit）的宿主都挂在 .page 里、紧挨末尾的
    // slip-canvas，而 .page 是普通块级容器（app.wxss:76，没有 flex / grid），
    // 不会因为多一个零高子节点而改变兄弟节点的排布。
    //
    // 谁要是加回来：tests/slip-image.test.js 末尾那条静态钉子会先红，
    // tests/ui.test.js 的 slipHost() 也会带着这段理由报错，不会静默失效。
  },
  properties: {
    showSlip: {
      type: Boolean,
      value: false
    },
    slip: {
      type: Object,
      value: null
    },
    exporting: {
      type: Boolean,
      value: false
    },
    showPicker: {
      type: Boolean,
      value: false
    },
    showCustomerPicker: {
      type: Boolean,
      value: false
    },
    exportStyle: {
      type: String,
      value: 'summary'
    }
  },
  methods: {
    onClose: function () {
      this.triggerEvent('close')
    },
    onExport: function () {
      this.triggerEvent('export')
    },
    onKeep: function () {},
    onStyleTap: function (e) {
      this.triggerEvent('stylechange', { style: e.currentTarget.dataset.style })
    }
  }
})
