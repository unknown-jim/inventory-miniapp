/**
 * 自绘 confirm-danger 弹层（稿 4:1017）。
 * 页面：<confirm-dialog id="confirmDialog" />
 * 调用：const res = await this.selectComponent('#confirmDialog').open({...})
 * res = { confirm: boolean, content?: string }
 */
Component({
  data: {
    show: false,
    title: '',
    body: '',
    impactLines: [],
    note: '',
    cancelText: '取消',
    confirmText: '确认',
    confirmTone: 'danger',
    showConfirm: true,
    editable: false,
    placeholder: '',
    inputValue: '',
    confirmDisabled: false
  },

  lifetimes: {
    detached() {
      this._finish({ confirm: false })
    }
  },

  methods: {
    noop() {},

    /**
     * @param {object} opts
     * @returns {Promise<{confirm:boolean, content?:string}>}
     */
    open(opts) {
      const self = this
      opts = opts || {}
      return new Promise(function (resolve) {
        self._finish({ confirm: false })
        self._resolver = resolve
        const showConfirm = opts.showConfirm !== false
        self.setData({
          show: true,
          title: opts.title || '',
          body: opts.body || '',
          impactLines: opts.impactLines || [],
          note: opts.note || '',
          cancelText: opts.cancelText != null ? opts.cancelText : '取消',
          confirmText: opts.confirmText || '确认',
          confirmTone: opts.confirmTone || 'danger',
          showConfirm: showConfirm,
          editable: !!opts.editable,
          placeholder: opts.placeholder || '',
          inputValue: opts.inputValue || '',
          confirmDisabled: !!opts.confirmDisabled
        })
      })
    },

    close() {
      this._finish({ confirm: false })
    },

    _finish(result) {
      if (!this._resolver) {
        if (this.data.show) this.setData({ show: false })
        return
      }
      const resolve = this._resolver
      this._resolver = null
      this.setData({ show: false })
      resolve(result)
    },

    onMask() {
      // 危险确认不点遮罩关闭，避免误触；与稿「必须点按钮」一致
    },

    onCancel() {
      this._finish({ confirm: false })
    },

    onConfirm() {
      if (this.data.confirmDisabled) return
      this._finish({
        confirm: true,
        content: this.data.inputValue
      })
    },

    onInput(e) {
      this.setData({ inputValue: (e.detail && e.detail.value) || '' })
    }
  }
})
