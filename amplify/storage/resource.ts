import { defineStorage } from '@aws-amplify/backend-storage';

// 定义存储资源，Amplify 会自动创建 S3 bucket，此处 name 为前端识别名称
export const storage = defineStorage({
  name: 'babyMonitorStorage',
  // 如果需要，可以配置自定义的访问规则，如下：
  access: (allow) => ({
    'captures/{entity_id}/*': [
      allow.authenticated.to(['read', 'write', 'delete']),
      allow.guest.to(['read'])
    ]
  })
});
