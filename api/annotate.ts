import { v4 as uuidv4 } from "uuid";

// 设置运行时为边缘函数
export const config = {
  runtime: "edge",
};

// 更新后的 ASCII 流程图
/*
+--------+     +------------------------+     +---------------------------+
| 开始   | --> | 解析 webhook 负载      | --> | 是否为 'created' 事件?    |
+--------+     +------------------------+     +---------------------------+
                                                          |
                  +--------------------+                  | 是
                  | 返回: 无需处理     | <-- 否 ----------+
                  +--------------------+                  |
                                                          v
              +---------------------------+     +---------------------------+
              | 返回: 未找到高亮数据      | <-- | 高亮数据是否存在?         |
              +---------------------------+     +---------------------------+
                                                          |
                  +--------------------+                  | 是
                  | 返回: 无需操作     | <-- 否 ----------+
                  +--------------------+                  |
                                                          v
                                              +---------------------------+
                                              | 创建新的 UUID 标签        |
                                              +---------------------------+
                                                          |
                                                          vv
                                              +---------------------------+
                                              | 准备设置标签的GraphQL     |
                                              | mutation                  |
                                              +---------------------------+
                                                          |
                                                          v
                                              +---------------------------+
                                              | 发送设置标签请求          |
                                              +---------------------------+
                                                          |
                                                          v
                                              +---------------------------+
                                              | 是否成功?                 |
                                              +---------------------------+
                                                 |                 |
                                                 | 是              | 否
                                                 v                 v
                                     +----------------------+ +-----------------+
                                     | 返回: 成功设置标签   | | 重试 (最多3次)  |
                                     +----------------------+ +-----------------+
                                                                      |
                                                                      v
                                                              +------------------+
                                                              | 是否所有重试     |
                                                              | 都失败?          |
                                                              +------------------+
                                                                 |            |
                                                                 | 是         | 否
                                                                 v            |
                                                     +--------------------+   |
                                                     | 返回: 设置标签失败 |   |
                                                     +--------------------+   |
                                                                              v
                                                                           结束
*/

// 接口定义
interface Highlight {
  id: string;
  type: string;
  annotation: string;
  labels: Array<{
    id: string;
    name: string;
    color: string;
  }>;
}

interface WebhookPayload {
  action: string;
  highlight?: Highlight;
}

interface CreateLabelInput {
  name: string;
  color?: string;
  description?: string;
}

interface SetLabelsForHighlightInput {
  highlightId: string;
  labels: CreateLabelInput[];
}

// 辅助函数：延迟执行
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// 主函数：处理 webhook 请求
export default async (req: Request): Promise<Response> => {
  try {
    // 解析 webhook 负载
    const body = await req.json();
    console.log("收到 webhook 负载:", JSON.stringify(body, null, 2));

    // 检查是否为 'created' 事件
    if (body.action !== "created") {
      console.log(`不是 'created' 事件，而是 '${body.action}'，无需处理。`);
      return new Response(`不是 'created' 事件，无需处理。`);
    }

    // 检查高亮数据是否存在
    const highlight = body.highlight;
    if (!highlight) {
      console.log("在 webhook 负载中未找到高亮数据。");
      return new Response("在 webhook 负载中未找到高亮数据。");
    }

    console.log(`收到 'created' webhook。高亮 ID: ${highlight.id}`);

    // 检查高亮 ID 是否存在
    if (!highlight.id) {
      console.log("高亮 ID 不存在，无需操作。");
      return new Response("高亮 ID 不存在，无需操作。");
    }

    // 创建新的 UUID 标签
    const labelUuid = uuidv4();
    const labelName = `uuid:${labelUuid}`;

    // 检查 OMNIVORE_API_KEY 是否设置
    const omnivoreApiKey = process.env["OMNIVORE_API_KEY"];
    if (!omnivoreApiKey) {
      console.error("OMNIVORE_API_KEY 未设置");
      return new Response("OMNIVORE_API_KEY 未设置", { status: 500 });
    }

    // 设置 API 请求头
    const omnivoreHeaders = {
      "Content-Type": "application/json",
      Authorization: omnivoreApiKey,
    };

    // 准备设置高亮标签的 GraphQL mutation
    const setLabelsForHighlightMutation = {
      query: `mutation SetLabelsForHighlight($input: SetLabelsForHighlightInput!) {
        setLabelsForHighlight(input: $input) {
          ... on SetLabelsForHighlightSuccess {
            highlight {
              id
              labels {
                id
                name
                color
              }
            }
          }
          ... on SetLabelsForHighlightError {
            errorCodes
          }
        }
      }`,
      variables: {
        input: {
          highlightId: highlight.id,
          labels: [{
            name: labelName,
            color: "#" + Math.floor(Math.random()*16777215).toString(16), // 随机颜色
            description: "自动生成的 UUID 标签",
          }],
        } as SetLabelsForHighlightInput,
      },
    };

    // 设置重试次数
    const maxRetries = 3;
    let retries = 0;
    let success = false;

    while (retries < maxRetries && !success) {
      try {
        console.log(`尝试设置高亮标签 (尝试 ${retries + 1}/${maxRetries})...`);
        console.log("设置高亮标签请求内容:", JSON.stringify(setLabelsForHighlightMutation, null, 2));
        
        const setLabelsRequest = await fetch(
          "https://api-prod.omnivore.app/api/graphql",“https://api-prod.omnivore.app/api/graphql”，
          {
            method: "POST",
            headers: omnivoreHeaders,
            body: JSON.stringify(setLabelsForHighlightMutation),
          }
        );
        
        const setLabelsResponse = await setLabelsRequest.json();
        console.log(`设置高亮标签的响应:`, JSON.stringify(setLabelsResponse, null, 2));

        if (setLabelsResponse.errors) {
          throw new Error(JSON.stringify(setLabelsResponse.errors));
        }

        success = true;
        console.log(`成功将标签 ${labelName} 设置到高亮。`);
      } catch (error) {
        console.error(`设置高亮标签时出错 (尝试 ${retries + 1}/${maxRetries}):`, error);
        retries++;
        if (retries < maxRetries) {
          console.log(`等待 ${retries * 2} 秒后重试...`);
          await delay(retries * 2000); // 指数退避
        }
      }
    }

    if (success) {
      return new Response(`已将标签 ${labelName} 设置到高亮。`);
    } else {
      return new Response(`设置高亮标签失败，已尝试 ${maxRetries} 次。请检查服务器日志以获取更多信息。`, { status: 500 });
    }

  } catch (error) {
    // 捕获并记录任何未预期的错误
    console.error("处理 Omnivore webhook 时出错:", error);
    return new Response(
      `处理 Omnivore webhook 时出错: ${(error as Error).message}`,
      { status: 500 }
    );
  }
};
