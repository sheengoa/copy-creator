export interface ApiKeyLabel {
  service: string;
  api_base: string;
  note: string;
  is_expired: boolean;
}

export interface ClipboardRecord {
  id: string;
  type: "text" | "image" | "link" | "file";
  content: string;
  content_length?: number;
  content_truncated?: boolean;
  source_app: string;
  created_at: string;
  is_api_key?: boolean;
  user_api_key?: boolean;
  key_preview?: string;
  guessed_service?: string | null;
  label?: ApiKeyLabel | null;
}

export interface PhraseGroup {
  id: string;
  name: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface Phrase {
  id: string;
  group_id: string;
  title: string;
  content: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface TranslationRecord {
  id: string;
  source_text: string;
  target_text: string;
  source_lang: string;
  target_lang: string;
  engine: "ai" | "google";
  created_at: string;
}
