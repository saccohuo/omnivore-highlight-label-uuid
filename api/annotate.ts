import { v4 as uuidv4 } from "uuid";

export const config = {
  runtime: "edge",
};

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

interface AddLabelToHighlightInput {
  highlightId: string;
  label: string;
}

export default async (req: Request): Promise<Response> => {
  try {
    const body: WebhookPayload = (await req.json()) as WebhookPayload;
    console.log("收到 webhook 负载:", body);

    if (body.action !== "HIGHLIGHT_CREATED") {
      return new Response("不是 HIGHLIGHT_CREATED 事件，无需处理。");
    }

    const highlight = body.highlight;

    if (!highlight) {
      return new Response("在 webhook 负载中未找到高亮数据。");
    }

    console.log(`收到 HIGHLIGHT_CREATED webhook。`, highlight);

    // 检查高亮是否存在
    if (!highlight.id) {
      return new Response("高亮不存在，无需操作。");
    }

    // 创建新的 UUID 标签
    const labelUuid = uuidv4();
    const labelName = `uuid:${labelUuid}`;

    const omnivoreHeaders = {
      "Content-Type": "application/json",
      Authorization: process.env["OMNIVORE_API_KEY"] ?? "",
    };

    // 创建新标签
    const createLabelMutation = {
      query: `mutation CreateLabel($input: CreateLabelInput!) {
        createLabel(input: $input) {
          ... on CreateLabelSuccess {
            label {
              id
              name
              color
              description
            }
          }
          ... on CreateLabelError {
            errorCodes
          }
        }
      }`,
      variables: {
        input: {
          name: labelName,
          color: "#" + Math.floor(Math.random()*16777215).toString(16), // 随机颜色
          description: "自动生成的 UUID 标签",
        } as CreateLabelInput,
      },
    };

    const createLabelRequest = await fetch(
      "https://api-prod.omnivore.app/api/graphql",
      {
        method: "POST",
        headers: omnivoreHeaders,
        body: JSON.stringify(createLabelMutation),
      }
    );
    const createLabelResponse = await createLabelRequest.json();
    console.log(`创建标签响应:`, createLabelResponse);

    // 将新标签添加到高亮
    const addLabelToHighlightMutation = {
      query: `mutation AddLabelToHighlight($input: AddLabelToHighlightInput!) {
        addLabelToHighlight(input: $input) {
          ... on AddLabelToHighlightSuccess {
            highlight {
              id
              type
              annotation
              labels {
                id
                name
                color
              }
            }
          }
          ... on AddLabelToHighlightError {
            errorCodes
          }
        }
      }`,
      variables: {
        input: {
          highlightId: highlight.id,
          label: labelName,
        } as AddLabelToHighlightInput,
      },
    };

    const addLabelRequest = await fetch(
      "https://api-prod.omnivore.app/api/graphql",
      {
        method: "POST",
        headers: omnivoreHeaders,
        body: JSON.stringify(addLabelToHighlightMutation),
      }
    );
    const addLabelResponse = await addLabelRequest.json();
    console.log(`将标签添加到高亮的响应:`, addLabelResponse);

    return new Response(`已将标签 ${labelName} 添加到高亮。`);

  } catch (error) {
    return new Response(
      `处理 Omnivore webhook 时出错: ${(error as Error).message}`,
      { status: 500 }
    );
  }
};
