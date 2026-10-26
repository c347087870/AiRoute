// 前端侧的「开发模式」判断 —— 开发面板只在这里为真时出现。
//
// 只看 Vite 的 import.meta.env.DEV：它由 `vite dev` 注入，`vite build` 时被静态
// 替换成 false，打包产物里连这段分支都留不下（tree-shaking 会连页面组件一起摇掉）。
// 刻意不用 NODE_ENV：渲染进程里它常被 Electron 主进程继承成别的值，
// 而 import.meta.env.DEV 描述的正是「这份前端是不是 dev server 现编的」。
export const isDevMode = !!import.meta.env.DEV
