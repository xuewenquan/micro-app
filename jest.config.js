// For a detailed explanation regarding each configuration property, visit:
// https://jestjs.io/docs/en/configuration.html

module.exports = {
  clearMocks: true,
  coverageDirectory: 'coverage',
  coverageReporters: [
    'json',
    'text',
    'lcov',
    'clover',
    'html'
  ],
  moduleFileExtensions: [
    'js',
    'json',
    'jsx',
    'ts',
    'tsx'
  ],
  transformIgnorePatterns: [
    '/node_modules/',
  ],
  testPathIgnorePatterns: [
    '/dev/',
    '/scripts/',
  ],
  coveragePathIgnorePatterns: [
    '/scripts/',
    '/__tests__/',
  ],
  transform: {
    '^.+\\.jsx?$': 'babel-jest',
    '^.+\\.tsx?$': 'ts-jest'
  },
  rootDir: __dirname,
  testMatch: [
    // '<rootDir>/src/__tests__/**/*.test.[jt]s?(x)'
    '<rootDir>/src/__tests__/main.test.ts',
    '<rootDir>/src/__tests__/create_app.test.ts',
    '<rootDir>/src/__tests__/micro_app_element.test.ts',
    '<rootDir>/src/__tests__/micro_app.test.ts',
    '<rootDir>/src/__tests__/unit/utils.test.ts',
    '<rootDir>/src/__tests__/unit/source_center.test.ts',
    '<rootDir>/src/__tests__/unit/app_tasks.test.ts',
    '<rootDir>/src/__tests__/unit/unmount_all_apps.test.ts',
    '<rootDir>/src/__tests__/unit/event_center_dispose.test.ts',
    '<rootDir>/src/__tests__/unit/event_descriptor_cleanup.test.ts',
    '<rootDir>/src/__tests__/unit/with_umd_hook_cleanup.test.ts',
    '<rootDir>/src/__tests__/unit/event_target_effect.test.ts',
    '<rootDir>/src/__tests__/unit/iframe_restore.test.ts',
    '<rootDir>/src/__tests__/unit/iframe_resource_cleanup.test.ts',
    '<rootDir>/src/__tests__/unit/iframe_destroy_safety.test.ts',
    '<rootDir>/src/__tests__/unit/iframe_module_script.test.ts',
    '<rootDir>/src/__tests__/unit/app_name_owner.test.ts',
    '<rootDir>/src/__tests__/unit/terminal_dom_cleanup.test.ts',
    '<rootDir>/src/__tests__/unit/animation_frame_cleanup.test.ts',
    '<rootDir>/src/__tests__/unit/resource_factory.test.ts',
    '<rootDir>/src/__tests__/unit/trusted_types_cleanup.test.ts',
    '<rootDir>/src/__tests__/unit/listener_capture_cleanup.test.ts',
    '<rootDir>/src/__tests__/unit/bind_function_cleanup.test.ts',
    '<rootDir>/src/__tests__/unit/global_snapshot_cleanup.test.ts',
    '<rootDir>/src/__tests__/unit/destroy_order.test.ts',
    '<rootDir>/src/__tests__/unit/with_document_dispose.test.ts',
    '<rootDir>/src/__tests__/unit/observer_cleanup.test.ts',
    '<rootDir>/src/__tests__/unit/router_history_sync.test.ts',
    '<rootDir>/src/__tests__/unit/scoped_css_dispose.test.ts',
    '<rootDir>/src/__tests__/unit/scoped_css_app_name.test.ts',
    '<rootDir>/src/__tests__/unit/vue_global_isolation.test.ts',
    '<rootDir>/src/__tests__/interact/index.test.ts',
    '<rootDir>/src/__tests__/source/scoped_css.test.ts',
  ],
  globals: {
    __DEV__: true,
    __TEST__: true,
    'ts-jest': {
      tsconfig: {
        target: 'ES2017',
        noUnusedLocals: true,
        strictNullChecks: true,
        noUnusedParameters: true,
        experimentalDecorators: true,
        allowSyntheticDefaultImports: true,
      }
    }
  }
}
