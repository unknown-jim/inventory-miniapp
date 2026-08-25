Component({
  properties: {
    padBottom: { type: Number, value: 12 },
    lift: { type: Boolean, value: false }
  },
  methods: {
    onMaskTap() {
      this.triggerEvent('close')
    },
    stopTap() {}
  }
})
