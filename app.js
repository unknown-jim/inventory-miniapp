App({
  globalData: {
    selectedProductId: '',
    selectedCustomerId: '',
    pendingInventoryFilter: ''
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
  },
  setPendingInventoryFilter(filter) {
    this.globalData.pendingInventoryFilter = filter || ''
  },
  consumePendingInventoryFilter() {
    const filter = this.globalData.pendingInventoryFilter
    this.globalData.pendingInventoryFilter = ''
    return filter
  }
})
