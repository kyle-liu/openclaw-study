# Runtime WhatsApp TS Syntax Cheatsheet

## 1. 这份小抄解决什么问题

这份小抄不是再讲完整架构，而是专门把
`src/plugins/runtime/runtime-whatsapp.ts`
里最常见、最容易让 Java 工程师卡住的 TypeScript 语法压缩成 5 个点。

一句话目标：

> 以后你再看 `runtime-whatsapp.ts`，先拿这张小抄对照，就能快速把“语法噪音”剥掉，只看核心设计。

---

## 2. 语法点一：对象解构赋值

源码里典型写法：

```ts
const { monitorWebChannel } = await loadWebChannel();
```

它不是“创建一个新对象”，而是：

> 从返回对象里按属性名取出 `monitorWebChannel`

等价展开：

```ts
const moduleObject = await loadWebChannel();
const monitorWebChannel = moduleObject.monitorWebChannel;
```

Java 对照理解：

```java
WebChannelModule moduleObject = await loadWebChannel();
var monitorWebChannel = moduleObject.monitorWebChannel;
```

最短记忆法：

```ts
const { x } = obj;
```

等价于：

```ts
const x = obj.x;
```

---

## 3. 语法点二：剩余参数 `...args`

源码里典型写法：

```ts
const monitorWebChannelLazy = async (...args) => {
  return monitorWebChannel(...args);
};
```

这里的 `...args` 表示：

> 把调用方传进来的所有参数先收集起来，再原样转发出去

Java 对照理解：

```java
Object... args
```

但这里更像“参数透传代理”，不是自己处理这些参数。

最短记忆法：

- 左边函数参数位置的 `...args`
  -> 收集多个参数
- 右边调用位置的 `fn(...args)`
  -> 把数组/参数列表再展开传出去

---

## 4. 语法点三：索引访问类型

源码里典型写法：

```ts
PluginRuntime["channel"]["whatsapp"]["monitorWebChannel"];
```

这叫：

> 索引访问类型（indexed access type）

注意：

- 这是**类型层**语法
- 不是运行时对象取值

它的意思是：

1. 从 `PluginRuntime` 类型里取 `channel`
2. 从 `channel` 类型里取 `whatsapp`
3. 从 `whatsapp` 类型里取 `monitorWebChannel`

最后得到的是：

> `monitorWebChannel` 这个字段对应的类型

Java 对照理解：

可以脑补成：

```java
WhatsAppApi.monitorWebChannel 的方法签名类型
```

它的真实目的不是炫技，而是：

> 让实现函数的签名和总接口里定义的方法签名自动保持一致

---

## 5. 语法点四：`typeof import("...")`

源码里典型写法：

```ts
typeof import("../../channels/web/index.js");
```

这不是执行导入，而是：

> 在类型系统里询问“这个模块对象的类型是什么”

注意区分两层：

### 运行时

```ts
import("../../channels/web/index.js");
```

表示动态导入模块，返回 Promise。

### 类型层

```ts
typeof import("../../channels/web/index.js");
```

表示这个模块对象本身的类型。

如果 `channels/web/index.ts` 导出了：

```ts
export { createWaSocket, loginWeb, monitorWebChannel };
```

那么 `typeof import("../../channels/web/index.js")` 可以脑补成：

```ts
{
  createWaSocket: ...,
  loginWeb: ...,
  monitorWebChannel: ...,
}
```

Java 对照理解：

可以脑补成一个自动推导出来的：

```java
WebChannelModule
```

只不过 TS 没有手写这个类名，而是直接从模块导出反推类型。

---

## 6. 语法点五：`Promise<typeof import("...")> | null`

源码里典型写法：

```ts
let webChannelPromise: Promise<typeof import("../../channels/web/index.js")> | null = null;
```

拆开看：

1. `typeof import("../../channels/web/index.js")`
   -> 模块对象类型

2. `Promise<...>`
   -> 装着这个模块对象的 Promise

3. `| null`
   -> 一开始还没加载，所以允许为空

整句白话翻译：

> 这里定义了一个变量，用来缓存 `channels/web/index.js` 这个模块的加载 Promise；在第一次加载前它是 `null`

Java 对照理解：

```java
private CompletableFuture<WebChannelModule> webChannelPromise = null;
```

---

## 7. 额外语法：`??=`

源码里典型写法：

```ts
webChannelPromise ??= import("../../channels/web/index.js");
```

意思是：

> 只有在左边是 `null` 或 `undefined` 时，才进行赋值

等价展开：

```ts
if (webChannelPromise == null) {
  webChannelPromise = import("../../channels/web/index.js");
}
```

这正好适合做懒加载缓存。

Java 对照理解：

```java
if (webChannelPromise == null) {
    webChannelPromise = loadModuleAsync(...);
}
```

---

## 8. 把这 5 个点串起来

当你看到这段代码：

```ts
const monitorWebChannelLazy: PluginRuntime["channel"]["whatsapp"]["monitorWebChannel"] = async (
  ...args
) => {
  const { monitorWebChannel } = await loadWebChannel();
  return monitorWebChannel(...args);
};
```

你应该这样翻译：

1. `PluginRuntime["channel"]["whatsapp"]["monitorWebChannel"]`
   -> 这个代理函数的签名必须和总接口里定义的方法签名一致

2. `async (...args)`
   -> 这是一个异步代理函数，收集所有入参

3. `const { monitorWebChannel } = await loadWebChannel()`
   -> 先加载模块对象，再从里面解构出 `monitorWebChannel`

4. `return monitorWebChannel(...args)`
   -> 把原始参数原样转发给真实实现

所以它的本质是：

> 一个类型受约束的懒加载代理函数

---

## 9. 最短总口诀

以后你再看 `runtime-whatsapp.ts`，可以直接套这个口诀：

1. `const { x } = obj`
   -> `const x = obj.x`

2. `...args`
   -> 收集参数 / 转发参数

3. `Type["a"]["b"]`
   -> 从类型里一路切到子类型

4. `typeof import("x")`
   -> 模块对象类型

5. `Promise<typeof import("x")> | null`
   -> 可为空的模块加载 Promise 缓存

6. `??=`
   -> 只有空时才赋值

---

## 10. 立刻可执行的复习方式

建议你下次复习时按这个顺序：

1. 先读这张小抄
2. 再打开 `src/plugins/runtime/runtime-whatsapp.ts`
3. 遇到每个复杂语法时，只做一件事：先翻译成“展开写法”
4. 最后再问自己：这里是在做业务，还是在做装配/懒加载/类型约束

如果你能稳定完成这一步，你看 TypeScript 工程代码的速度会快很多。
