// CSS import declarations for the website app global stylesheet.

/// <reference path="../worker-configuration.d.ts" />

declare module '*.css' {
  const content: string
  export default content
}

declare module '*.datasource?raw' {
  const content: string
  export default content
}

declare module '*.pipe?raw' {
  const content: string
  export default content
}
