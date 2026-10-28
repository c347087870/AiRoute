// dev 模式启动 Electron 的垫片。
//
// 为什么需要它：`ELECTRON_RUN_AS_NODE` 只要存在（哪怕值是空字符串），Electron 就会
// 以纯 Node 模式启动 —— `require('electron')` 退化成 exe 路径字符串，主进程第一行
// 解构出来的 `app` 是 undefined，随后 `app.getPath(...)` 直接抛
// "Cannot read properties of undefined"。而 `cross-env ELECTRON_RUN_AS_NODE=`
// 清不掉它（实测仍是 Node 模式，Electron 判断的是「变量在不在」而不是「值真不真」）。
//
// 这个变量常由父进程继承而来（例如从编辑器 / 集成终端 / 其他 Electron 应用里启动
// 本项目的 dev），不是机器上的永久环境变量，所以只能在启动前把它删掉。
//
// 用法：node scripts/start-electron.js [electron 的参数...]
// 不传参默认启动当前项目（`.`）。
const { spawn } = require('child_process')

// 普通 Node 下 require('electron') 返回的就是可执行文件路径
const electronPath = require('electron')

// 必须在 spawn 之前删：子进程继承的是这里的 process.env
delete process.env.ELECTRON_RUN_AS_NODE

const args = process.argv.slice(2)
if (args.length === 0) args.push('.')

const child = spawn(electronPath, args, { stdio: 'inherit', env: process.env })

// 退出码原样转发，concurrently 才能正确判定 dev 会话是否失败
child.on('close', code => process.exit(code === null ? 1 : code))
child.on('error', error => {
  console.error('[aiRoute] Electron 启动失败:', error.message)
  process.exit(1)
})
