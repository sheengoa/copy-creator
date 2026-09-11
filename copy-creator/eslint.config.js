import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist', 'src-tauri/target']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
    },
    rules: {
      'react-hooks/set-state-in-effect': 'off',
      // 领域层边界（DOMAIN_ARCHITECTURE_PLAN.md §5.1）：媒体地址解析唯一出口
      'no-restricted-imports': ['error', {
        paths: [{
          name: '@tauri-apps/api/core',
          importNames: ['convertFileSrc'],
          message: 'convertFileSrc 仅允许在 src/domain/mediaUrl.ts 使用，请改用 resolveResourceAssetUrl/resolveResourceMediaUrl。',
        }],
      }],
      // 预览/媒体/存储类后端命令禁止 UI 层直调，收口 domain 或 stores
      'no-restricted-syntax': ['error',
      {
        selector: "CallExpression[callee.name='invoke'][arguments.0.value='read_clipboard_text_preview']",
        message: '预览/媒体/存储类命令必须经 domain 或 stores 调用（见 domain/README.md）。',
      },
      {
        selector: "CallExpression[callee.name='invoke'][arguments.0.value='read_resource_text_preview']",
        message: '预览/媒体/存储类命令必须经 domain 或 stores 调用（见 domain/README.md）。',
      },
      {
        selector: "CallExpression[callee.name='invoke'][arguments.0.value='read_text_file_content']",
        message: '预览/媒体/存储类命令必须经 domain 或 stores 调用（见 domain/README.md）。',
      },
      {
        selector: "CallExpression[callee.name='invoke'][arguments.0.value='get_image_thumbnail']",
        message: '预览/媒体/存储类命令必须经 domain 或 stores 调用（见 domain/README.md）。',
      },
      {
        selector: "CallExpression[callee.name='invoke'][arguments.0.value='get_resource_file_thumbnail']",
        message: '预览/媒体/存储类命令必须经 domain 或 stores 调用（见 domain/README.md）。',
      },
      {
        selector: "CallExpression[callee.name='invoke'][arguments.0.value='get_media_server_origin']",
        message: '预览/媒体/存储类命令必须经 domain 或 stores 调用（见 domain/README.md）。',
      },
      {
        selector: "CallExpression[callee.name='invoke'][arguments.0.value='get_storage_path']",
        message: '预览/媒体/存储类命令必须经 domain 或 stores 调用（见 domain/README.md）。',
      },
      {
        selector: "CallExpression[callee.name='invoke'][arguments.0.value='open_resource_file']",
        message: '预览/媒体/存储类命令必须经 domain 或 stores 调用（见 domain/README.md）。',
      },
      ],
    },
  },
  {
    // domain/stores 层豁免：领域与数据层是这些出口的合法使用者
    files: ['src/domain/**', 'src/stores/**'],
    rules: {
      'no-restricted-imports': 'off',
      'no-restricted-syntax': 'off',
    },
  },
  {
    // 过渡降级：UI 层仍有 6 处待收编（InlinePreview/RadialMenu/SettingsContent/
    // ResourceDetailPage/ResourceMedia），收编完成后删掉本段恢复 error。
    files: ['src/components/**', 'src/pages/**'],
    rules: {
      'no-restricted-syntax': 'warn',
    },
  },
])
