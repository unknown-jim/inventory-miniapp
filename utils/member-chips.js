function memberChipLabel(item, myOpenid) {
  const displayName = String((item && item.displayName) || '').trim()
  if (displayName) return displayName
  if (myOpenid && item && item.openid === myOpenid) return '我'
  if (item && item.role === 'owner') return '店主'
  return '店员'
}

function memberChips(members, selectedOpenid, myOpenid) {
  return (members || []).map(function (item) {
    const displayName = String(item.displayName || '').trim()
    return {
      openid: item.openid,
      displayName: displayName,
      label: memberChipLabel(item, myOpenid),
      on: item.openid === selectedOpenid
    }
  })
}

module.exports = {
  memberChipLabel: memberChipLabel,
  memberChips: memberChips
}
