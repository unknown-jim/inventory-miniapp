// 本机账本分片上传的**规划**：只算「怎么切」，不碰任何 IO、不 require wx。
// 切法本身会改钱——把退货单和它的被退销售单切到两片里，repairReturnSplits
// 会把那组份额一分都不重算（docs/cloud-ledger.md「不要做」里实测欠款翻倍
// 那条），所以分片规则的唯一硬约束是：一张销售单和它的全部退货单必须落在
// 同一片里。这份约束在这里只用**一份定义**维护：归并和「退货 → 销售」的
// 指向都读 utils/inventory.js 的 migrateRecordShape / recordGroups，
// 不另抄一套规则。
const inventory = require('./inventory')

// 一片就是云函数里的一个事务。上限**是拍的，没实测出真实边界**：2026-08-24 实测
// 一个事务里写 92 条文档就会被服务端丢弃（[ResourceUnavailable.TransactionNotExist]，
// 「transaction must be commit or abort in 30 seconds」，而云函数耗时才 12–16 秒，
// 所以不是简单的 30 秒墙）。40 条留了一倍多的余量；判的是**归并后**的条数，
// 因为落库写的是归并后的文档。
const SHARD_RECORDS = 40
// 另一堵墙是请求体大小。这里数的是 JSON.stringify 之后的**字符数**，不是字节数
//（中文一个字符最多 3 字节，20 万字符最坏约 600 KB）。同样是拍的：
// wx.cloud.callFunction 的请求体上限本仓没实测过，这个数只是留余量，
// 免得一条巨型多行单把整个请求撑爆。
const SHARD_CHARS = 200000

// planShards(records, options) —— 把本机原始流水切成若干片，保证服务端逐片归并
// 出来的钱和整本一次性上传逐项相等。
//
// 返回 {
//   shards: [[原始流水, ...], ...],   // 每一片仍然是**原始**（未归并）流水
//   mergedCount: n,                   // 归并后的总条数（= 会落库的文档数）
//   orphanReturns: [{ id, saleOrderId }], // 找不到被退销售单的退货单（归并后视角）
//   oversized: [{ mergedCount, chars }]   // 单个原子组自己就超限、只能自成一片
// }
// options: { limit = SHARD_RECORDS, chars = SHARD_CHARS }
//
// 片内的原始记录**可能不再是本机数组的原顺序**（原子组按「组内最小下标」排，
// 退货单会被拉到销售单旁边）。这不影响钱：recomputeSaleReturns 自己按
// (createdAt, id) 升序排；applyTermsDelta 是可加的；store.set 按 _id 写。
function planShards(records, options) {
  options = options || {}
  const limit = options.limit != null ? options.limit : SHARD_RECORDS
  const charsLimit = options.chars != null ? options.chars : SHARD_CHARS
  const raw = records || []
  if (!raw.length) {
    return { shards: [], mergedCount: 0, orphanReturns: [], oversized: [] }
  }

  // 先深拷贝一份再归并：migrateRecordShape 里的 backfillReturnedQty 会**就地改**
  // 销售行的 returnedQty / returnedAmount（legacyRecordsOf 用的 cloneList 只是浅拷贝，
  // lines 数组是共享的）。规划只是读，绝不能改到本机原件。
  const probe = JSON.parse(JSON.stringify(raw))
  const groups = inventory.recordGroups(probe)
  const merged = inventory.needsRecordMigration(probe)
    ? inventory.migrateRecordShape(probe)
    : probe
  // 防御性断言不写成 throw：对应关系真被破坏（说明归并定义变了），退回
  // 「整本一片」的退化计划——一片就是一次性上传，行为和 2b-1 完全一致，安全侧。
  if (groups.length !== merged.length) {
    return {
      shards: [raw.slice()],
      mergedCount: merged.length,
      orphanReturns: [],
      oversized: []
    }
  }

  // 并查集：parent[i] = i，find 带路径压缩（迭代实现，几千条的书不吃调用栈）
  const parent = []
  for (let i = 0; i < merged.length; i++) parent.push(i)
  function find(x) {
    let root = x
    while (parent[root] !== root) root = parent[root]
    while (parent[x] !== root) {
      const next = parent[x]
      parent[x] = root
      x = next
    }
    return root
  }
  function union(a, b) {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent[rb] = ra
  }

  // saleAt：销售单 id → 归并后下标（先到先得）。idAt：同 id 的第一条下标，
  // 之后每次出现都 union 过去——V8「重复 id」是逐片判的，切开就没人报，
  // 而两条同 id 记录落库时 _id 相同、后写覆盖先写、聚合却加了两次，是静默
  // 错账；同片则 V8 照旧报错、整次上传被拒，和一次性上传行为一致。
  const saleAt = Object.create(null)
  const idAt = Object.create(null)
  for (let i = 0; i < merged.length; i++) {
    const id = String((merged[i] && merged[i].id) || '')
    if (!id) continue
    if (merged[i].type === 'out' && saleAt[id] === undefined) saleAt[id] = i
    if (idAt[id] === undefined) {
      idAt[id] = i
    } else {
      union(idAt[id], i)
    }
  }

  // 退货 ↔ 销售：每条退货单的每一行都判（assertReturnsPaired 也是逐行判的，
  // 一条退货理论上可以牵多张销售单，全部 union）。saleOrderId 为空、或指向的
  // 销售单整本账里都不存在（跨账套 / 已删）就是孤儿——带 token 的路上任何切法
  // 都会被 assertReturnsPaired 拒绝，调用方要整本退回一次性上传。
  const orphanReturns = []
  const orphanSeen = Object.create(null)
  for (let i = 0; i < merged.length; i++) {
    if (!merged[i] || merged[i].type !== 'return') continue
    inventory.recordLines(merged[i]).forEach(function (line) {
      const saleId = String((line && line.saleOrderId) || '')
      const at = saleId ? saleAt[saleId] : undefined
      if (at === undefined) {
        if (!orphanSeen[i]) {
          orphanSeen[i] = true
          orphanReturns.push({ id: String(merged[i].id || ''), saleOrderId: saleId })
        }
        return
      }
      union(i, at)
    })
  }

  // 按「组内第一个下标」的顺序排出原子组
  const atoms = []
  const atomByRoot = Object.create(null)
  for (let i = 0; i < merged.length; i++) {
    const root = find(i)
    if (atomByRoot[root] === undefined) {
      atomByRoot[root] = atoms.length
      atoms.push({ mergedCount: 0, items: [], chars: 0 })
    }
    const atom = atoms[atomByRoot[root]]
    atom.mergedCount += 1
    const items = (groups[i] && groups[i].items) || []
    for (let k = 0; k < items.length; k++) atom.items.push(items[k])
  }
  atoms.forEach(function (atom) {
    atom.chars = JSON.stringify(atom.items).length
  })

  // 按原子组顺序贪心装箱。当前片为空时无条件收下——单个原子组自己就超限也
  // 自成一片（数进 oversized，由调用方决定要不要警告），不然这本书就永远
  // 传不上去了。
  const shards = []
  const oversized = []
  let current = null
  atoms.forEach(function (atom) {
    if (!current) {
      current = { mergedCount: 0, chars: 0, items: [] }
      shards.push(current.items)
      if (atom.mergedCount > limit || atom.chars > charsLimit) {
        oversized.push({ mergedCount: atom.mergedCount, chars: atom.chars })
      }
    } else if (current.mergedCount + atom.mergedCount > limit
      || current.chars + atom.chars > charsLimit) {
      current = { mergedCount: 0, chars: 0, items: [] }
      shards.push(current.items)
    }
    current.mergedCount += atom.mergedCount
    current.chars += atom.chars
    for (let k = 0; k < atom.items.length; k++) current.items.push(atom.items[k])
  })

  return {
    shards: shards,
    mergedCount: merged.length,
    orphanReturns: orphanReturns,
    oversized: oversized
  }
}

module.exports = {
  SHARD_RECORDS: SHARD_RECORDS,
  SHARD_CHARS: SHARD_CHARS,
  planShards: planShards
}
