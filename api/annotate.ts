import OpenAI from "openai";
import { v4 as uuidv4 } from "uuid";

export const config = {
  runtime: "edge",
};

// 接口定义
interface Label {
  id: string;
  name: string;
  color: string;
}

interface LabelPayload {
  pageId: string;
  labels: Label[];
}

interface PagePayload {
  id: string;
  // ... (其他 PagePayload 字段保持不变)
}

interface WebhookPayload {
  action: string;
  label?: LabelPayload;
  page?: PagePayload;
}

interface CreateLabelInput {
  name: string;
  color?: string;
  description?: string;
}

interface CreateHighlightInput {
  id: string;
  shortId: string;
  articleId: string;
  patch?: string;
  quote?: string;
  prefix?: string;
  suffix?: string;
  annotation?: string;
  sharedAt?: string;
  highlightPositionPercent?: number;
  highlightPositionAnchorIndex?: number;
  type?: string;
  html?: string;
  color?: string;
  representation?: string;
}

export default async (req: Request): Promise<Response> => {
  try {
    const body: WebhookPayload = (await req.json()) as WebhookPayload;
    console.log("收到 webhook 负载:", body);
    const label = body.label as LabelPayload;
    const pageCreated = body.page as PagePayload;

    let webhookType: "LABEL_ADDED" | "PAGE_CREATED";
    // 检测 webhook 类型
    if (label) {
      webhookType = "LABEL_ADDED";
    } else if (pageCreated) {
      webhookType = "PAGE_CREATED";
    } else {
      throw new Error("在 webhook 负载中未找到标签或页面数据。");
    }
    let articleId = "";
    // 从环境中获取要注释的标签
    const annotateLabel = process.env["OMNIVORE_ANNOTATE_LABEL"] ?? "";

    switch (webhookType) {
      case "LABEL_ADDED":
        console.log(`收到 LABEL_ADDED webhook。`, label);

        if (!annotateLabel) {
          throw new Error("环境中未指定标签。");
        }

        const labels = label?.labels || [label];
        const labelNames = labels.map((label) => label.name.split(":")[0]);
        const matchedLabel = labelNames.find(
          (labelName) => labelName === annotateLabel
        );

        if (!matchedLabel) {
          throw new Error(
            `标签 "${annotateLabel}" 与 webhook 中提供的标签 <${labelNames.join(
              ", "
            )}> 不匹配。`
          );
        }
        articleId = label.pageId;
        break;

      case "PAGE_CREATED":
        console.log(`收到 PAGE_CREATED webhook。`, pageCreated);
        articleId = pageCreated.id;
        break;

      default:
        const errorMessage = "既未收到标签数据，也不是 PAGE_CREATED 事件。";
        console.log(errorMessage);
        return new Response(errorMessage, {
          status: 400,
        });
    }

    // 步骤 1: 从 Omnivore 获取完整的文章内容
    const omnivoreHeaders = {
      "Content-Type": "application/json",
      Authorization: process.env["OMNIVORE_API_KEY"] ?? "",
    };

    interface FetchQueryResponse {
      data: {
        article: {
          article: {
            content: string;
            title: string;
            labels: Array<{
              name: string;
              description: string;
            }>;
            highlights: Array<{
              id: string;
              type: string;
            }>;
          };
        };
      };
    }

    let fetchQuery = {
      query: `query Article {
        article(
          slug: "${articleId}"
          username: "."
          format: "markdown"
        ) {
          ... on ArticleSuccess {
            article {
              title
              content
              labels {
                name
                description
              }
              highlights(input: { includeFriends: false }) {
                id
                shortId
                user {
                  id
                  name
                  createdAt
                }
                type
              }
            }
          }
        }
      }`,
    };

    const omnivoreRequest = await fetch(
      "https://api-prod.omnivore.app/api/graphql",
      {
        method: "POST",
        headers: omnivoreHeaders,
        body: JSON.stringify(fetchQuery),
        redirect: "follow",
      }
    );
    const omnivoreResponse =
      (await omnivoreRequest.json()) as FetchQueryResponse;

    const {
      data: {
        article: {
          article: {
            content: articleContent,
            title: articleTitle,
            labels: articleLabels,
            highlights,
          },
        },
      },
    } = omnivoreResponse;

    const promptFromLabel = articleLabels.find(
      ({ name }) => name.split(":")[0] === annotateLabel
    )?.description;

    const existingNote = highlights.find(({ type }) => type === "NOTE");

    if (articleContent.length < 280) {
      throw new Error("文章内容少于 280 个字符，无需总结。");
    }

    // 步骤 2: 使用 OpenAI 的 API 生成补全
    const openai = new OpenAI();
    let prompt =
      promptFromLabel ||
      process.env["OPENAI_PROMPT"] ||
      "返回以下文章的推特长度 TL;DR。";
    const model = process.env["OPENAI_MODEL"] || "gpt-4o-mini";
    const settings = process.env["OPENAI_SETTINGS"] || `{"model":"${model}"}`;

    const completionResponse = await openai.chat.completions
      .create({
        ...JSON.parse(settings),
        messages: [
          {
            role: "user",
            content: `指令: ${prompt} 
文章标题: ${articleTitle}
文章内容: ${articleContent}`,
          },
        ],
      })
      .catch((err) => {
        throw err;
      });

    console.log(
      `已为文章 "${articleTitle}" (ID: ${articleId}) 使用提示 "${prompt}" 从 OpenAI 获取补全: ${JSON.stringify(
        completionResponse.usage
      )}`
    );

    const articleAnnotation = (
      completionResponse?.choices?.[0].message?.content || ""
    )
      .trim()
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"');

    // 步骤 3: 创建新的 UUID 标签
    const labelUuid = uuidv4();
    const labelName = `uuid:${labelUuid}`;

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

    // 步骤 4: 创建或更新高亮，并添加新创建的标签
    let highlightMutation: {
      query: string;
      variables: {
        input: CreateHighlightInput;
      };
    };

    const fragment = `
      fragment HighlightFields on Highlight {
        id
        type
        shortId
        quote
        prefix
        suffix
        patch
        color
        annotation
        createdByMe
        createdAt
        updatedAt
        sharedAt
        highlightPositionPercent
        highlightPositionAnchorIndex
        labels {
          id
          name
          color
          createdAt
        }
      }`;

    if (existingNote) {
      highlightMutation = {
        query: `mutation UpdateHighlight($input: UpdateHighlightInput!) {
          updateHighlight(input: $input) {
            ... on UpdateHighlightSuccess {
              highlight {
                ...HighlightFields
              }
            }
            ... on UpdateHighlightError {
              errorCodes
            }
          }
        }${fragment}`,
        variables: {
          input: {
            id: existingNote.id,
            shortId: existingNote.shortId,
            articleId: articleId,
            annotation: articleAnnotation,
          },
        },
      };
    } else {
      const id = uuidv4();
      const shortId = id.substring(0, 8);

      highlightMutation = {
        query: `mutation CreateHighlight($input: CreateHighlightInput!) {
          createHighlight(input: $input) {
            ... on CreateHighlightSuccess {
              highlight {
                ...HighlightFields
              }
            }
            ... on CreateHighlightError {
              errorCodes
            }
          }
        }${fragment}`,
        variables: {
          input: {interface LabelPayload {
            id: id,
            shortId: shortId,
            articleId: articleId,
            annotation: articleAnnotation,
            type: "NOTE",
          },
        },
      };
    }

    const highlightRequest = await fetch(
      "https://api-prod.omnivore.app/api/graphql",
      {
        method: "POST",
        headers: omnivoreHeaders,
        body: JSON.stringify(highlightMutation),
      }
    );
    const highlightResponse = await highlightRequest.json();
    console.log(`高亮创建/更新响应:`, highlightResponse);

    // 步骤 5: 将新标签添加到高亮
    const addLabelToHighlightMutation = {
      query: `mutation AddLabelToHighlight($input: AddLabelToHighlightInput!) {
        addLabelToHighlight(input: $input) {
          ... on AddLabelToHighlightSuccess {
            highlight {
              ...HighlightFields
            }
          }
          ... on AddLabelToHighlightError {
            errorCodes
          }
        }
      }${fragment}`,
      variables: {
        input: {
          highlightId: existingNote ? existingNote.id : highlightMutation.variables.input.id,
          label: labelName,
        },
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

    return new Response(`已添加带有标签 ${labelName} 的文章注释。`);

  } catch (error) {
    return new Response(
      `将注释添加到 Omnivore 文章时出错: ${(error as Error).message}`,
      { status: 500 }
    );
  }
};
