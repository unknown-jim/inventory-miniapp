Component({
  options: { multipleSlots: true },
  properties: {
    go: { type: Boolean, value: false },       // 右侧 › 箭头（进详情的行）
    minTap: { type: Boolean, value: false }    // 行高不低于 --tap-min（shop 的可点行）
  }
})
