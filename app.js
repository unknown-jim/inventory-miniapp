App({
  globalData: {
    selectedProductId: ''
  },
  setSelectedProduct(id) {
    this.globalData.selectedProductId = id || ''
  },
  consumeSelectedProduct() {
    const id = this.globalData.selectedProductId
    this.globalData.selectedProductId = ''
    return id
  }
})
