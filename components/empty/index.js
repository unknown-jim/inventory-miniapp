Component({
  properties: {
    title: String,
    desc: String,
    card: { type: Boolean, value: false }  // 卡片外观（白底/圆角/投影）画在组件根节点，避免宿主 .card 的 padding 嵌套叠加
  }
})
