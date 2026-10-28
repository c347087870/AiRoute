// public/ 下的静态资源地址
//
// 打包后渲染层由 file:// 加载（见 app/main/main.js 的 loadFile），
// 模板里写死的 `/brand-x.svg` 会被解析成磁盘根目录的 C:\brand-x.svg，
// 于是所有品牌图与站点图标在安装版里都裂开。开发态（vite dev）BASE_URL 是 `/`，
// 打包后（vite.config.js 的 base: './'）是 `./`，两种形态都能解析到正确位置。
const BASE = import.meta.env.BASE_URL

export function assetUrl(path) {
  return `${BASE}${String(path || '').replace(/^\//, '')}`
}
