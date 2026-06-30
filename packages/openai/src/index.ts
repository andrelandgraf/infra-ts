/**
 * `@infra-ts/openai` — OpenAI entities for infra-ts.
 *
 * `OpenAiProject` and `OpenAiServiceAccount` (write-once `OPENAI_API_KEY`). These use the OpenAI
 * Administration API, so credentials resolve from `OPENAI_ADMIN_KEY` (an admin key, `sk-admin-…`).
 */
export {
	OpenAiProject,
	OpenAiServiceAccount,
	type OpenAiProjectOptions,
	type OpenAiServiceAccountOptions,
} from "./lib/entities.js";
