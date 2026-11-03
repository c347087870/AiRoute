// 生成 macOS 图标资源：build/icon.png / build/icon.icns 与菜单栏模板图
// 只依赖 Node 内置模块（zlib），避免构建环境额外安装图像处理工具。
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')
const { execFileSync } = require('child_process')

const root = path.resolve(__dirname, '..')
const sourcePath = path.join(root, 'app', 'renderer', 'public', 'icon.png')
const buildDir = path.join(root, 'build')
const publicDir = path.join(root, 'app', 'renderer', 'public')

// ==================== PNG 编解码 ====================

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const typeBuf = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])))
  return Buffer.concat([len, typeBuf, data, crc])
}

function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) {
    const rowStart = y * (width * 4 + 1)
    raw[rowStart] = 0 // filter: none
    rgba.copy(raw, rowStart + 1, y * width * 4, (y + 1) * width * 4)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

function decodePng(buf) {
  let offset = 8
  let width = 0
  let height = 0
  let colorType = 0
  const idat = []
  while (offset < buf.length) {
    const len = buf.readUInt32BE(offset)
    const type = buf.toString('ascii', offset + 4, offset + 8)
    const data = buf.subarray(offset + 8, offset + 8 + len)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      if (data[8] !== 8) throw new Error('只支持 8 位 PNG')
      colorType = data[9]
      if (data[12] !== 0) throw new Error('不支持隔行扫描 PNG')
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') break
    offset += 12 + len
  }
  if (colorType !== 2 && colorType !== 6) throw new Error(`不支持的颜色类型: ${colorType}`)
  const channels = colorType === 6 ? 4 : 3
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const out = Buffer.alloc(width * height * 4)
  let prev = Buffer.alloc(stride)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)))
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? line[i - channels] : 0
      const b = prev[i]
      const c = i >= channels ? prev[i - channels] : 0
      let v = line[i]
      if (filter === 1) v += a
      else if (filter === 2) v += b
      else if (filter === 3) v += Math.floor((a + b) / 2)
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      line[i] = v & 0xff
    }
    prev = line
    for (let x = 0; x < width; x++) {
      const s = x * channels
      const d = (y * width + x) * 4
      out[d] = line[s]
      out[d + 1] = line[s + 1]
      out[d + 2] = line[s + 2]
      out[d + 3] = channels === 4 ? line[s + 3] : 255
    }
  }
  return { width, height, rgba: out }
}

// ==================== 图像处理 ====================

// 从四边泛洪去除白底：只去掉与画布边缘连通的近白像素，图标内部的白色笔画不会被误删
function removeWhiteBackground({ width, height, rgba }) {
  const out = Buffer.from(rgba)
  const visited = new Uint8Array(width * height)
  const stack = []
  const isWhite = (x, y) => {
    const i = (y * width + x) * 4
    return out[i] > 242 && out[i + 1] > 242 && out[i + 2] > 242
  }
  const push = (x, y) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return
    const p = y * width + x
    if (visited[p] || !isWhite(x, y)) return
    visited[p] = 1
    stack.push([x, y])
  }
  for (let x = 0; x < width; x++) {
    push(x, 0)
    push(x, height - 1)
  }
  for (let y = 0; y < height; y++) {
    push(0, y)
    push(width - 1, y)
  }
  while (stack.length) {
    const [x, y] = stack.pop()
    out[(y * width + x) * 4 + 3] = 0
    push(x + 1, y)
    push(x - 1, y)
    push(x, y + 1)
    push(x, y - 1)
  }
  return { width, height, rgba: out }
}

function alphaBounds({ width, height, rgba }) {
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (rgba[(y * width + x) * 4 + 3] < 8) continue
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 }
}

// 面积平均缩放，避免缩小时出现锯齿
function resize(src, sw, sh, dw, dh, sx = 0, sy = 0, cw = sw, ch = sh) {
  const out = Buffer.alloc(dw * dh * 4)
  for (let y = 0; y < dh; y++) {
    const y0 = sy + (y * ch) / dh
    const y1 = sy + ((y + 1) * ch) / dh
    for (let x = 0; x < dw; x++) {
      const x0 = sx + (x * cw) / dw
      const x1 = sx + ((x + 1) * cw) / dw
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      let n = 0
      for (let py = Math.floor(y0); py < Math.ceil(y1); py++) {
        for (let px = Math.floor(x0); px < Math.ceil(x1); px++) {
          if (px < 0 || py < 0 || px >= sw || py >= sh) continue
          const i = (py * sw + px) * 4
          const alpha = src[i + 3] / 255
          r += src[i] * alpha
          g += src[i + 1] * alpha
          b += src[i + 2] * alpha
          a += alpha
          n++
        }
      }
      const d = (y * dw + x) * 4
      if (a > 0) {
        out[d] = Math.round(r / a)
        out[d + 1] = Math.round(g / a)
        out[d + 2] = Math.round(b / a)
        out[d + 3] = Math.round((a / n) * 255)
      }
    }
  }
  return out
}

// macOS 图标网格：1024 画布，内容区 824×824 居中，视觉留白与系统图标一致
function composeMacIcon(source) {
  const bgRemoved = removeWhiteBackground(source)
  const bounds = alphaBounds(bgRemoved)
  if (bounds.width < 16 || bounds.height < 16) throw new Error('源图标内容为空')
  const canvas = Buffer.alloc(1024 * 1024 * 4)
  const content = resize(bgRemoved.rgba, source.width, source.height, 824, 824, bounds.x, bounds.y, bounds.width, bounds.height)
  for (let y = 0; y < 824; y++) {
    content.copy(canvas, ((y + 100) * 1024 + 100) * 4, y * 824 * 4, (y + 1) * 824 * 4)
  }
  return canvas
}

// ==================== 菜单栏模板图 ====================

// 菜单栏图标必须与 App 图标同源，否则用户会觉得"不是同一个应用"。
// 这里直接从源图标的白色字形提取轮廓（而不是另画一个图形），保证两者视觉一致。
// 输出仍是 macOS 模板图：纯黑 RGB + alpha，由系统随菜单栏明暗自动反色。
function smoothstep(edge0, edge1, x) {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

function extractTrayMask(source) {
  const { width, height, rgba } = source

  // 1. 先定位深色圆角方块（App 图标主体）。只在方块内部采样白色字形，
  // 避免把方块外面的白色背景也算进字形，避免抗锯齿边缘污染轮廓
  let sx0 = width
  let sy0 = height
  let sx1 = -1
  let sy1 = -1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      if (rgba[i + 3] < 200) continue
      const min = Math.min(rgba[i], rgba[i + 1], rgba[i + 2])
      if (min > 90) continue
      if (x < sx0) sx0 = x
      if (x > sx1) sx1 = x
      if (y < sy0) sy0 = y
      if (y > sy1) sy1 = y
    }
  }
  if (sx1 < sx0 || sy1 < sy0) throw new Error('未找到应用图标底色')

  // 深色边缘检测会把白色字形内部也混进来（中心菱形的抗锯齿边缘），
  // 导致 bbox 撑满整张画布。真正的圆角方块至少要有明确的深色主体：
  // 若 bbox 超过画布 95%，改用不透明像素的 bbox 作为方块范围兜底
  let bx0 = sx0
  let by0 = sy0
  let bx1 = sx1
  let by1 = sy1
  if (sx1 - sx0 + 1 > width * 0.95 || sy1 - sy0 + 1 > height * 0.95) {
    const full = alphaBounds(source)
    bx0 = full.x
    by0 = full.y
    bx1 = full.x + full.width - 1
    by1 = full.y + full.height - 1
  }

  const inset = 2
  const x0 = Math.max(0, bx0 + inset)
  const y0 = Math.max(0, by0 + inset)
  const x1 = Math.min(width - 1, bx1 - inset)
  const y1 = Math.min(height - 1, by1 - inset)
  const bw = x1 - x0 + 1
  const bh = y1 - y0 + 1
  if (bw < width * 0.3 || bh < height * 0.3) throw new Error('应用图标底色区域过小')
  if (Math.abs(bw - bh) > Math.min(bw, bh) * 0.2) throw new Error('应用图标底色不是方形，无法定位字形')

  // 2. 方块内部按亮度提取白色字形：白 → 1，深色底 → 0，抗锯齿边缘得到中间权重
  const mask = new Float32Array(width * height)
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const i = (y * width + x) * 4
      if (rgba[i + 3] < 200) continue
      const min = Math.min(rgba[i], rgba[i + 1], rgba[i + 2])
      const w = smoothstep(100, 235, min)
      if (w > 0.02) mask[y * width + x] = w
    }
  }

  // 2.1 圆角方块的四个角是方块外的白色背景，它和字形一样亮，会被误当成字形
  // （包围盒随之扩成整个方块，最后输出方形剪影）。从区域四角泛洪，只吃掉
  // 与四角连通的高亮像素；字形被深色方块包住，碰不到
  const cornerOutside = new Uint8Array(width * height)
  const cornerStack = []
  const pushCorner = (x, y) => {
    if (x < x0 || x > x1 || y < y0 || y > y1) return
    const p = y * width + x
    if (cornerOutside[p] || mask[p] < 0.5) return
    cornerOutside[p] = 1
    cornerStack.push([x, y])
  }
  pushCorner(x0, y0)
  pushCorner(x1, y0)
  pushCorner(x0, y1)
  pushCorner(x1, y1)
  while (cornerStack.length) {
    const [x, y] = cornerStack.pop()
    pushCorner(x + 1, y)
    pushCorner(x - 1, y)
    pushCorner(x, y + 1)
    pushCorner(x, y - 1)
  }
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const p = y * width + x
      if (cornerOutside[p]) mask[p] = 0
    }
  }

  // 3. 填充字形内部空洞（源图标中心是一个深色菱形）。只从方块边缘泛洪，
  // 与边缘连通的深色像素是图标背景；被封在字形内部的深色像素是空洞，填实
  const visited = new Uint8Array(width * height)
  const stack = []
  const push = (x, y) => {
    if (x < x0 || x > x1 || y < y0 || y > y1) return
    const p = y * width + x
    if (visited[p] || mask[p] >= 0.5) return
    visited[p] = 1
    stack.push([x, y])
  }
  for (let x = x0; x <= x1; x++) {
    push(x, y0)
    push(x, y1)
  }
  for (let y = y0; y <= y1; y++) {
    push(x0, y)
    push(x1, y)
  }
  while (stack.length) {
    const [x, y] = stack.pop()
    push(x + 1, y)
    push(x - 1, y)
    push(x, y + 1)
    push(x, y - 1)
  }
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const p = y * width + x
      if (!visited[p] && mask[p] < 0.5) mask[p] = 1
    }
  }

  // 4. 裁出字形包围盒，并做一次形状校验。App 图标里的罗盘星横向比纵向宽
  // （横向臂更长），长宽比 1.2–1.5 属正常；只有明显失衡才说明提取到了底色边缘。
  // 渲染时会按原比例缩放，不会强行拉成方形
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (mask[y * width + x] <= 0.08) continue
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
  if (maxX < minX || maxY < minY) throw new Error('未能从应用图标中提取出字形')
  const glyphW = maxX - minX + 1
  const glyphH = maxY - minY + 1
  const aspect = Math.max(glyphW / glyphH, glyphH / glyphW)
  if (aspect > 1.8) {
    throw new Error(`提取到的字形长宽比异常（${glyphW}×${glyphH}）`)
  }

  // 5. 最后的保底校验：字形面积应明显小于方块内部（罗盘星约占 40–60%）。
  // 接近 90% 说明四角背景没被清掉，提取到的其实是方块剪影，直接退回程序化图标
  let glyphArea = 0
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      if (mask[y * width + x] >= 0.5) glyphArea++
    }
  }
  const density = glyphArea / (glyphW * glyphH)
  if (density > 0.82) throw new Error(`提取到的字形过于饱满（密度 ${density.toFixed(2)}），疑似方块剪影`)

  return { width, height, mask, bounds: { x: minX, y: minY, width: glyphW, height: glyphH } }
}

// 在 18pt 网格里画一个四角罗盘星（提取失败时的兜底，形态与 App 图标一致）
function drawFallbackStar(size) {
  const scale = 8
  const px = Buffer.alloc(size * size * 4)
  const cx = size / 2
  const cy = size / 2
  const outer = size * 0.44
  const inner = size * 0.12
  const points = []
  for (let k = 0; k < 8; k++) {
    const angle = -Math.PI / 2 + (k * Math.PI) / 4
    const radius = k % 2 === 0 ? outer : inner
    points.push([cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius])
  }
  const inside = (x, y) => {
    let hit = false
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
      const [xi, yi] = points[i]
      const [xj, yj] = points[j]
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit
    }
    return hit
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let covered = 0
      for (let sy = 0; sy < scale; sy++) {
        for (let sx = 0; sx < scale; sx++) {
          if (inside(x + (sx + 0.5) / scale, y + (sy + 0.5) / scale)) covered++
        }
      }
      const i = (y * size + x) * 4
      px[i + 3] = Math.round((covered / (scale * scale)) * 255)
    }
  }
  return px
}

// 从字形蒙版生成指定尺寸的模板图：内容区按 16/18 比例留白，长宽比不变，
// 每个目标像素做 8×8 面积采样，18px 与 36px 使用同一套坐标，保证 @2x 真正是两倍清晰度
function renderTrayFromMask(extracted, size) {
  const px = Buffer.alloc(size * size * 4)
  const bounds = extracted.bounds
  const content = (size * 16) / 18
  const aspect = bounds.width / bounds.height
  const boxW = aspect >= 1 ? content : content * aspect
  const boxH = aspect >= 1 ? content / aspect : content
  const offX = (size - boxW) / 2
  const offY = (size - boxH) / 2
  const samples = 8
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let sum = 0
      for (let sy = 0; sy < samples; sy++) {
        const v = (y + (sy + 0.5) / samples - offY) / boxH
        if (v < 0 || v >= 1) continue
        const gy = bounds.y + Math.min(bounds.height - 1, Math.floor(v * bounds.height))
        for (let sx = 0; sx < samples; sx++) {
          const u = (x + (sx + 0.5) / samples - offX) / boxW
          if (u < 0 || u >= 1) continue
          const gx = bounds.x + Math.min(bounds.width - 1, Math.floor(u * bounds.width))
          sum += extracted.mask[gy * extracted.width + gx]
        }
      }
      const i = (y * size + x) * 4
      px[i] = 0
      px[i + 1] = 0
      px[i + 2] = 0
      px[i + 3] = Math.round((sum / (samples * samples)) * 255)
    }
  }
  return px
}

// 生成菜单栏渲染器；提取失败时退回程序化四角星，保证构建不中断
function createTrayRenderer(source) {
  let extracted = null
  try {
    extracted = extractTrayMask(source)
    console.log(`[icons] 菜单栏字形提取成功：${extracted.bounds.width}×${extracted.bounds.height}`)
  } catch (err) {
    console.warn('[icons] 菜单栏字形提取失败，使用兜底罗盘星：', err.message)
  }
  return (size) => (extracted ? renderTrayFromMask(extracted, size) : drawFallbackStar(size))
}

// ==================== 输出 ====================

fs.mkdirSync(buildDir, { recursive: true })
fs.mkdirSync(publicDir, { recursive: true })

const source = decodePng(fs.readFileSync(sourcePath))
console.log(`[icons] 源图 ${source.width}×${source.height}`)

const macIcon = composeMacIcon(source)
fs.writeFileSync(path.join(buildDir, 'icon.png'), encodePng(1024, 1024, macIcon))

// 生成 iconset 并尝试用 iconutil 打包 icns；失败时 electron-builder 会回退用 PNG 自动转换
const iconsetDir = path.join(buildDir, 'icon.iconset')
fs.rmSync(iconsetDir, { recursive: true, force: true })
fs.mkdirSync(iconsetDir, { recursive: true })
const iconSizes = [
  [16, 'icon_16x16.png'],
  [32, 'icon_16x16@2x.png'],
  [32, 'icon_32x32.png'],
  [64, 'icon_32x32@2x.png'],
  [128, 'icon_128x128.png'],
  [256, 'icon_128x128@2x.png'],
  [256, 'icon_256x256.png'],
  [512, 'icon_256x256@2x.png'],
  [512, 'icon_512x512.png'],
  [1024, 'icon_512x512@2x.png']
]
for (const [size, name] of iconSizes) {
  const pixels = size === 1024 ? macIcon : resize(macIcon, 1024, 1024, size, size)
  fs.writeFileSync(path.join(iconsetDir, name), encodePng(size, size, pixels))
}
try {
  execFileSync('iconutil', ['-c', 'icns', iconsetDir, '-o', path.join(buildDir, 'icon.icns')], { stdio: 'pipe' })
  console.log('[icons] 已生成 build/icon.icns')
} catch (err) {
  console.warn('[icons] iconutil 不可用，跳过 icns（electron-builder 将使用 PNG）:', err.message.split('\n')[0])
}

const renderTray = createTrayRenderer(source)
fs.writeFileSync(path.join(publicDir, 'trayTemplate.png'), encodePng(18, 18, renderTray(18)))
fs.writeFileSync(path.join(publicDir, 'trayTemplate@2x.png'), encodePng(36, 36, renderTray(36)))
console.log('[icons] 已生成菜单栏模板图 trayTemplate.png / trayTemplate@2x.png')
