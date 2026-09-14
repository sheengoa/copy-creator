# testing/ 跨栈契约测试

集中放置**读取源码文本做断言**的跨层守卫测试（architectureGuard /
integrationRegression / windowChrome）。约定：

- 与被测文件同目录的 `*.test.ts` 只放纯函数 / 行为单测；
- 任何需要跨 TS / CSS / Rust 源码断言的新守卫一律放本目录；
- 本目录测试用 `import.meta.url` 相对定位源码，移动文件时必须同步
  修正各 readSource / readStyle 的相对前缀。
