App({
  globalData: {
    selectedProductId: '',
    selectedCustomerId: ''
  },
  setSelectedProduct(id) {
    this.globalData.selectedProductId = id || ''
  },
  consumeSelectedProduct() {
    const id = this.globalData.selectedProductId
    this.globalData.selectedProductId = ''
    return id
  },
  setSelectedCustomer(id) {
    this.globalData.selectedCustomerId = id || ''
  },
  consumeSelectedCustomer() {
    const id = this.globalData.selectedCustomerId
    this.globalData.selectedCustomerId = ''
    return id
  }
})
