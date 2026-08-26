Component({
  properties: {
    label: String,
    mode: { type: String, value: '' },      // '' | readonly | picker
    value: { type: null, value: '' },       // readonly/picker 的显示值
    fallback: { type: String, value: '' },  // readonly 值为空时显示
    last: { type: Boolean, value: false },  // 卡片内最后一个字段，去底部间距
    dense: { type: Boolean, value: false }  // spec-block 内的紧凑间距 8rpx
  }
})
