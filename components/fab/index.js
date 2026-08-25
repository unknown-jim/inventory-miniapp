Component({
  properties: {
    text: String,
    lift: { type: Boolean, value: false }
  },
  methods: {
    onTap() {
      this.triggerEvent('press')
    }
  }
})
