Component({
  options: {
    styleIsolation: 'apply-shared',
    virtualHost: true
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
    }
  },
  methods: {
    onClose: function () {
      this.triggerEvent('close')
    },
    onExport: function () {
      this.triggerEvent('export')
    },
    onKeep: function () {}
  }
})
