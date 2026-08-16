const KEY = 'inv_ui_scale'
const LEVELS = ['std', 'lg', 'xl']
const DEFAULT = 'lg'

function readScale() {
  const value = wx.getStorageSync(KEY)
  if (LEVELS.indexOf(value) >= 0) return value
  return DEFAULT
}

function writeScale(level) {
  if (LEVELS.indexOf(level) < 0) return readScale()
  wx.setStorageSync(KEY, level)
  return level
}

function scaleClass(level) {
  return 'ui-' + (level || readScale())
}

function applyToPage(page) {
  const uiScale = readScale()
  page.setData({
    uiScale: uiScale,
    uiScaleClass: scaleClass(uiScale)
  })
}

function handleSetUiScale(e) {
  const level = e.currentTarget.dataset.level
  writeScale(level)
  applyToPage(this)
}

const behavior = Behavior({
  data: {
    uiScale: DEFAULT,
    uiScaleClass: 'ui-' + DEFAULT
  },
  onShow: function () {
    applyToPage(this)
  },
  setUiScale: handleSetUiScale,
  methods: {
    setUiScale: handleSetUiScale
  }
})

module.exports = {
  KEY: KEY,
  LEVELS: LEVELS,
  DEFAULT: DEFAULT,
  readScale: readScale,
  writeScale: writeScale,
  scaleClass: scaleClass,
  behavior: behavior
}
