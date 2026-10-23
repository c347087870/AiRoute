// 从 dsh-our-free-model 的渠道包产物生成 AiRoute 自用的渠道业务模块
//
//     OFM_CHANNEL_PACK=/path/to/dsh-our-free-model/vendor/channel-pack/pack.js \
//       node scripts/build-channels.js
//
// 改写规则本身在同目录的 channel-pack-transform.js（生成与校验共用一条管线），
// 「为什么不能直接 require 原包」也写在那里。生成结果是
// `server/channels/business.mjs`，属于**产物**：改渠道行为要回到上游改源码后
// 重跑本脚本，不要手改产物（`scripts/verify-channels.js` 会逐字节比对抓出来）。

const fs = require('fs')
const path = require('path')
const { transform } = require('./channel-pack-transform')

const root = path.join(__dirname, '..')
const source = process.env.OFM_CHANNEL_PACK || ''
const outFile = path.join(root, 'server', 'channels', 'business.mjs')

if (!source || !fs.existsSync(source)) {
  console.error('build-channels: 需要 OFM_CHANNEL_PACK 指向 dsh-our-free-model/vendor/channel-pack/pack.js')
  process.exit(1)
}

const output = transform(fs.readFileSync(source))
fs.writeFileSync(outFile, output)
console.log(`[aiRoute] 已生成 ${path.relative(root, outFile)}（${(output.length / 1024 / 1024).toFixed(2)} MB）`)
