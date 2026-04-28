// ============================================================================
// plugins/runtime/runtime-whatsapp.ts
//
// 这个文件是插件运行时里 `runtime.channel.whatsapp` 这部分能力面的装配器。
//
// 如果结合你前面已经学过的几个文件来看：
// - `types-channel.ts`：定义 `whatsapp` 这部分 API 应该长什么样
// - `runtime-channel.ts`：组装整个 `runtime.channel`
// - `runtime-whatsapp.ts`：专门负责组装 `runtime.channel.whatsapp`
//
// 因此，这个文件的核心职责不是实现 WhatsApp 功能本身，而是：
// 1. 把 WhatsApp / Web 相关能力按插件 runtime 需要的结构组织起来
// 2. 对某些较重模块使用 lazy import，避免启动时一次性加载过多代码
// 3. 返回一个满足 `PluginRuntime["channel"]["whatsapp"]` 类型契约的对象
//
// Java 对照理解：
// 这很像一个 `WhatsAppRuntimeFactory`，负责返回一个 `WhatsAppApi` 实现对象。
//
// 如果强行翻译成 Java 结构，大致像这样：
//
//   interface WhatsAppApi { ... }
//   final class WhatsAppRuntimeFactory {
//     WhatsAppApi createRuntimeWhatsApp() { ... }
//   }
//
// 也就是说：
// - `types-channel.ts` 更像接口定义处
// - 这里更像接口实现对象的装配处
// ============================================================================

import { createWhatsAppLoginTool } from "../../channels/plugins/agent-tools/whatsapp-login.js";
import { getActiveWebListener } from "../../web/active-listener.js";
import {
  getWebAuthAgeMs,
  logoutWeb,
  logWebSelfId,
  readWebSelfId,
  webAuthExists,
} from "../../web/auth-store.js";
import type { PluginRuntime } from "./types.js";

// 下面这几组 `xxxLazy` 函数，是典型的“懒加载包装器”：
// - 外部调用它们时，看起来像普通 API
// - 内部第一次真正调用时，才动态 import 对应模块
//
// 这样做的主要好处：
// 1. 降低启动时初始加载成本
// 2. 把较重或较少使用的功能延后到真正需要时再加载
// 3. 避免在 runtime 初始化阶段引入不必要的模块依赖
//
// Java 对照理解：
// 有点像“懒初始化代理方法”或“Supplier + memoized loader”。
//
// 可以脑补成 Java 里的这种结构：
//
//   class WhatsAppApiImpl implements WhatsAppApi {
//     Result sendMessage(...) {
//       WebOutboundModule module = loadWebOutbound();
//       return module.sendMessage(...);
//     }
//   }
//
// 也就是：
// - 方法签名先对外稳定暴露
// - 真正实现延迟到第一次调用时再取到
//
// 这里还有一个非常典型的 TypeScript 语法：
//
//   PluginRuntime["channel"]["whatsapp"]["sendMessageWhatsApp"]
//
// 这叫“索引访问类型”（indexed access type）。
// 注意：这里是“类型层”的写法，不是在运行时真的去取对象值。
//
// 它的意思是：
// 1. 先从 `PluginRuntime` 这个总类型里取出 `channel` 字段的类型
// 2. 再从里面取出 `whatsapp` 字段的类型
// 3. 再从里面取出 `sendMessageWhatsApp` 这个字段的类型
//
// 所以它最终拿到的，不是对象本身，而是：
// “`PluginRuntime.channel.whatsapp.sendMessageWhatsApp` 这个方法签名对应的类型”。
//
// 完整 Java 对照理解：
// 可以脑补成“从总接口一路点到子接口的方法签名”：
//
//   PluginRuntime
//     -> channel
//       -> whatsapp
//         -> sendMessageWhatsApp(...)
//
// 如果换成更接近 Java 的直白写法，你可以直接脑补成：
//
//   WhatsAppApi.SendMessageWhatsAppMethodType
//
// 或者更朴素地理解成：
//
//   “让这个变量的函数签名，强制和 WhatsAppApi 接口里的
//    sendMessageWhatsApp(...) 方法签名保持一致”
//
// 下面第一次出现的这句：
//
//   const { sendMessageWhatsApp } = await loadWebOutbound();
//
// 是 TypeScript / JavaScript 里的“对象解构赋值”。
// 它不是“重新创建一个对象”，而是“从返回对象里按属性名取值”。
//
// 完整展开写法等价于：
//
//   const moduleObject = await loadWebOutbound();
//   const sendMessageWhatsApp = moduleObject.sendMessageWhatsApp;
//
// Java 对照理解：
//
//   WebOutboundModule moduleObject = await loadWebOutbound();
//   var sendMessageWhatsApp = moduleObject.sendMessageWhatsApp;
//
// 所以这里最终赋给变量 `sendMessageWhatsApp` 的，不是整个模块对象，
// 而是模块对象上的 `sendMessageWhatsApp` 这个成员。
const sendMessageWhatsAppLazy: PluginRuntime["channel"]["whatsapp"]["sendMessageWhatsApp"] = async (
  ...args
) => {
  // 语法点：`const { x } = obj`
  // 等价于：`const x = obj.x`
  const { sendMessageWhatsApp } = await loadWebOutbound();
  return sendMessageWhatsApp(...args);
};

// Java 语法对照：
// - `const sendMessageWhatsAppLazy = async (...args) => { ... }`
//   可以脑补成一个实现了接口方法的代理函数
// - `PluginRuntime["channel"]["whatsapp"]["sendMessageWhatsApp"]`
//   可以脑补成 `WhatsAppApi` 接口里的 `sendMessageWhatsApp(...)` 方法签名
// - `...args`
//   类似 Java 里的可变参数 `Object... args`，这里只是把原始参数原样透传
const sendPollWhatsAppLazy: PluginRuntime["channel"]["whatsapp"]["sendPollWhatsApp"] = async (
  ...args
) => {
  // 同样是对象解构：
  // `const { sendPollWhatsApp } = await loadWebOutbound()`
  // 等价于：
  // `const sendPollWhatsApp = (await loadWebOutbound()).sendPollWhatsApp`
  const { sendPollWhatsApp } = await loadWebOutbound();
  return sendPollWhatsApp(...args);
};

// Java 对照理解：
// 这和上面是同一个套路，只是代理到 `sendPollWhatsApp(...)`。
// 你可以把这一组 `xxxLazy` 看成：
//
//   class WhatsAppApiProxy implements WhatsAppApi { ... }
//
// 其中每个方法都先 `loadXxx()`，再调用真实模块。
const loginWebLazy: PluginRuntime["channel"]["whatsapp"]["loginWeb"] = async (...args) => {
  // 这里依然不是把整个模块赋给 `loginWeb`，
  // 而是从模块对象中拆出 `loginWeb` 这个属性。
  const { loginWeb } = await loadWebLogin();
  return loginWeb(...args);
};

// Java 对照理解：
// 这里代理的是二维码登录相关模块里的某个公开方法。
// 外层看起来仍然像：
//
//   whatsappApi.startWebLoginWithQr(...)
//
// 但内部实际是：
//
//   WebLoginQrModule module = loadWebLoginQr();
//   return module.startWebLoginWithQr(...);
const startWebLoginWithQrLazy: PluginRuntime["channel"]["whatsapp"]["startWebLoginWithQr"] = async (
  ...args
) => {
  // 对象解构展开后可以脑补成：
  // const moduleObject = await loadWebLoginQr();
  // const startWebLoginWithQr = moduleObject.startWebLoginWithQr;
  const { startWebLoginWithQr } = await loadWebLoginQr();
  return startWebLoginWithQr(...args);
};

// Java 对照理解：
// 这里继续复用同一个 `loadWebLoginQr()` loader。
// 说明：
// - 一个模块对象里可以导出多个方法
// - 多个代理方法可以共用同一个模块缓存
const waitForWebLoginLazy: PluginRuntime["channel"]["whatsapp"]["waitForWebLogin"] = async (
  ...args
) => {
  // 这里和上面完全同型：
  // 从同一个模块对象里解构出另一个成员 `waitForWebLogin`
  const { waitForWebLogin } = await loadWebLoginQr();
  return waitForWebLogin(...args);
};

// Java 对照理解：
// 这里代理的是更上层的 Web channel 模块能力。
// 可以脑补成：
//
//   WebChannelModule module = loadWebChannel();
//   return module.monitorWebChannel(...);
const monitorWebChannelLazy: PluginRuntime["channel"]["whatsapp"]["monitorWebChannel"] = async (
  ...args
) => {
  // 这是你刚才问到的典型解构写法：
  //
  //   const { monitorWebChannel } = await loadWebChannel();
  //
  // 它等价于：
  //
  //   const moduleObject = await loadWebChannel();
  //   const monitorWebChannel = moduleObject.monitorWebChannel;
  //
  // 所以最终变量 `monitorWebChannel` 的类型，
  // 是模块对象里 `monitorWebChannel` 这个属性自己的类型，
  // 通常会是一个函数类型，而不是整个模块对象类型。
  const { monitorWebChannel } = await loadWebChannel();
  return monitorWebChannel(...args);
};

// Java 对照理解：
// 这里的写法换成普通 Java 方法体，大概会像：
//
//   public Result handleWhatsAppAction(...) {
//     WhatsAppActionsModule module = loadWhatsAppActions();
//     return module.handleWhatsAppAction(...);
//   }
const handleWhatsAppActionLazy: PluginRuntime["channel"]["whatsapp"]["handleWhatsAppAction"] =
  async (...args) => {
    // 这里仍然是同一个语法模式：
    // `const { handleWhatsAppAction } = obj`
    // = 从对象中按名字拿出 `handleWhatsAppAction` 成员
    const { handleWhatsAppAction } = await loadWhatsAppActions();
    return handleWhatsAppAction(...args);
  };

// 这些 Promise 变量是“模块加载缓存”。
//
// 关键点：
// - 第一次调用 loader 时，执行动态 import(...)
// - 之后再次调用时，直接复用同一个 Promise
//
// 这样既实现了 lazy loading，又避免重复 import 同一模块。
//
// Java 对照理解：
// 这些变量像一组“延迟初始化后的模块句柄缓存”。
//
// 可以脑补成：
//
//   private CompletableFuture<WebLoginQrModule> webLoginQrPromise;
//   private CompletableFuture<WebChannelModule> webChannelPromise;
//
// 只不过在 TypeScript 里，“模块”不是一个 class 实例，
// 而更像“一个包含多个导出函数的模块对象”。
//
// 这里最难的一段语法是：
//
//   Promise<typeof import("../../channels/web/index.js")> | null
//
// 这句可以拆成 4 层理解：
//
// 1. `import("../../channels/web/index.js")`
//    这是运行时的动态导入表达式
//    运行时返回一个 Promise
//
// 2. `typeof import("../../channels/web/index.js")`
//    这是类型层的写法
//    表示“这个模块对象本身的类型”
//
// 3. `Promise<typeof import("../../channels/web/index.js")>`
//    表示“装着该模块对象的 Promise 类型”
//
// 4. `| null`
//    表示一开始还没加载，所以允许变量先是空的
//
// 因此整句白话翻译就是：
// “这里有一个变量，用来缓存 `channels/web/index.js` 模块的加载 Promise；
//  没加载之前是 `null`，加载后就是一个 Promise<模块对象类型>。”
//
// Java 对照理解：
//
//   private CompletableFuture<WebChannelModule> webChannelPromise = null;
//
// 注意：
// TypeScript 这里没有手写 `WebChannelModule` 这个类名，
// 而是通过 `typeof import(...)` 自动从模块导出推导出模块对象类型。
let webLoginQrPromise: Promise<typeof import("../../web/login-qr.js")> | null = null;
let webChannelPromise: Promise<typeof import("../../channels/web/index.js")> | null = null;
let webOutboundPromise: Promise<typeof import("./runtime-whatsapp-outbound.runtime.js")> | null =
  null;
let webLoginPromise: Promise<typeof import("./runtime-whatsapp-login.runtime.js")> | null = null;
let whatsappActionsPromise: Promise<
  typeof import("../../agents/tools/whatsapp-actions.js")
> | null = null;

// 每个 loadXxx() 都是在做“memoized dynamic import”。
// 语法点：
// - `??=` 表示“只有在左侧是 null/undefined 时才赋值”
// - 所以第一次会真正 import，后面都会复用缓存结果
//
// Java 对照理解：
// 每个 `loadXxx()` 都像一个“带缓存的懒加载 getter”：
//
//   WebOutboundModule loadWebOutbound() {
//     if (cached == null) cached = realLoad();
//     return cached;
//   }
//
// 这里只是因为 JS 的动态 import 天然返回 Promise，
// 所以缓存的不是模块实例本身，而是“模块加载中的 Promise”。
function loadWebOutbound() {
  webOutboundPromise ??= import("./runtime-whatsapp-outbound.runtime.js");
  return webOutboundPromise;
}

// Java 对照理解：
// 相当于：
//
//   private CompletableFuture<WebLoginModule> loadWebLogin() { ... }
//
// 它不负责“执行业务登录”，只负责“把登录模块加载出来”。
function loadWebLogin() {
  webLoginPromise ??= import("./runtime-whatsapp-login.runtime.js");
  return webLoginPromise;
}

// Java 对照理解：
// 这个函数是一个专门面向 `login-qr` 模块的 loader。
// 调用它的人并不关心模块路径，只关心“给我二维码登录相关能力”。
//
// 这有点像工厂内部的私有 helper：
//
//   private CompletableFuture<WebLoginQrModule> loadWebLoginQr() { ... }
function loadWebLoginQr() {
  webLoginQrPromise ??= import("../../web/login-qr.js");
  return webLoginQrPromise;
}

// Java 对照理解：
// 这里加载的是 `channels/web/index.js` 这个“对外聚合入口模块”。
// 所以你可以把它脑补成在加载一个 facade / gateway module。
function loadWebChannel() {
  webChannelPromise ??= import("../../channels/web/index.js");
  return webChannelPromise;
}

// Java 对照理解：
// 同理，这是一个 actions 模块的私有 loader。
function loadWhatsAppActions() {
  whatsappActionsPromise ??= import("../../agents/tools/whatsapp-actions.js");
  return whatsappActionsPromise;
}

// 这是本文件的核心工厂函数。
//
// 返回值类型 `PluginRuntime["channel"]["whatsapp"]` 的意思是：
// - 从顶层 runtime 类型 `PluginRuntime`
// - 取出 `channel`
// - 再取出其中的 `whatsapp`
// - 作为当前函数必须满足的结构约束
//
// Java 对照理解：
// 你可以把它脑补成：
//
//   WhatsAppApi createRuntimeWhatsApp()
//
// 只不过 TypeScript 这里更喜欢从总接口里切片取类型，而不是直接写单独子接口名。
//
// 这里的：
//
//   PluginRuntime["channel"]["whatsapp"]
//
// 仍然是前面讲过的“索引访问类型”。
// 只不过这次不是继续切到某个具体方法，而是切到整个 `whatsapp` 子接口。
//
// 所以这一句可以翻译成：
// “`createRuntimeWhatsApp()` 这个函数必须返回一个对象，
//  且这个对象在结构上必须满足 `PluginRuntime.channel.whatsapp` 这整个子接口。”
//
// 再换成更完整一点的 Java 脑图：
//
//   public WhatsAppApi createRuntimeWhatsApp() {
//     return new WhatsAppApiImpl(...);
//   }
//
// 只不过 TypeScript 常见写法不是 `new XxxImpl()`，
// 而是直接 `return { ... }` 返回一个对象字面量，让它在结构上满足接口。
export function createRuntimeWhatsApp(): PluginRuntime["channel"]["whatsapp"] {
  return {
    // 这些是“轻量且可直接同步暴露”的能力：
    // 不需要经过动态 import，直接引用现有函数即可。
    //
    // Java 对照理解：
    // 很像构造实现对象时，直接把现成依赖方法挂到实现类上，
    // 或者理解为这些方法已经在 classpath 里、无需再延迟加载。
    getActiveWebListener,
    getWebAuthAgeMs,
    logoutWeb,
    logWebSelfId,
    readWebSelfId,
    webAuthExists,

    // 这些是“通过 lazy wrapper 暴露”的能力：
    // 真正实现会在第一次调用时再动态加载。
    //
    // Java 对照理解：
    // 这像是在 `WhatsAppApiImpl` 里注入一组代理方法，
    // 每个代理方法第一次执行时才去拿真正模块。
    sendMessageWhatsApp: sendMessageWhatsAppLazy,
    sendPollWhatsApp: sendPollWhatsAppLazy,
    loginWeb: loginWebLazy,
    startWebLoginWithQr: startWebLoginWithQrLazy,
    waitForWebLogin: waitForWebLoginLazy,
    monitorWebChannel: monitorWebChannelLazy,
    handleWhatsAppAction: handleWhatsAppActionLazy,

    // 这个工具创建函数直接暴露，不需要懒加载。
    //
    // Java 对照理解：
    // 相当于一个轻量工厂方法，直接作为接口实现对象的一个方法暴露出去。
    createLoginTool: createWhatsAppLoginTool,
  };
}
