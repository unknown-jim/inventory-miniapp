Component({
  properties: {
    text: String,                              // util.money 输出，不含 ¥
    role: { type: String, value: 'row' }       // hero | stat | display | row
  },
  data: { size: '' },
  observers: {
    'text, role': function (text, role) {
      const len = ('¥' + (text || '')).length
      let size = ''
      if (role === 'hero') size = len >= 14 ? ' sm' : len >= 11 ? ' md' : ''
      else if (role === 'stat') size = len >= 10 ? ' sm' : ''
      this.setData({ size })
    }
  }
})
