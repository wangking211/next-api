/**
 * 消息实例桥。
 *
 * antd 的 `message` 必须来自 `<App>` 上下文（`App.useApp()`）才能跟随主题与语言，
 * 而 QueryClient 的 MutationCache 活在 React 树之外 —— 这里用一个模块级引用把两者接起来：
 * `<MessageBridge />` 在挂载时注册实例，MutationCache 通过 `notifyError()` 弹提示。
 */
export interface GlobalMessage {
  error: (content: string) => void;
}

let instance: GlobalMessage | null = null;

export function setMessageInstance(next: GlobalMessage | null): void {
  instance = next;
}

/** 全局错误提示（尚未挂载 App 上下文时静默丢弃，避免测试环境报错） */
export function notifyError(content: string): void {
  instance?.error(content);
}
