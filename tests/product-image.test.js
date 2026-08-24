// 商品图工具（utils/product-image.js）的 node 测试。
// 选图 / 压缩 / 上传都吃 wx 运行时，node 里跑不了；这里钉住纯函数和模块形状：
// cloudPath 前缀和服务端校验（cloudfunctions/ledger/ledger-core.js 的
// validShopImageFileId）是配套约定，两边谁改了另一边必须跟着动。
const assert = require('assert')
const productImage = require('../utils/product-image')

assert.strictEqual(productImage.MAX_EDGE, 600)
assert.strictEqual(productImage.JPEG_QUALITY, 0.7)

assert.strictEqual(productImage.buildCloudPath('s1', 'abc'), 'shops/s1/products/abc.jpg')
assert.strictEqual(productImage.buildCloudPath('shop-42', 'x9y8'), 'shops/shop-42/products/x9y8.jpg')

const nameA = productImage.makeFileName()
const nameB = productImage.makeFileName()
assert.notStrictEqual(nameA, nameB, 'makeFileName 两次调用必须不同名')
assert.ok(/^[a-z0-9]+$/.test(nameA), 'makeFileName 只含 [a-z0-9]：' + nameA)
assert.ok(/^[a-z0-9]+$/.test(nameB), 'makeFileName 只含 [a-z0-9]：' + nameB)

// 模块形状钉住：改名 / 漏导出在这里红，不用等真机
assert.strictEqual(typeof productImage.canUseImage, 'function')
assert.strictEqual(typeof productImage.makeFileName, 'function')
assert.strictEqual(typeof productImage.buildCloudPath, 'function')
assert.strictEqual(typeof productImage.compressImage, 'function')
assert.strictEqual(typeof productImage.uploadProductImage, 'function')

console.log('product-image tests passed')
