// WeChat Work (企业微信) protocol type definitions
// Extracted from the ClawBot WeChat plugin API

// ── Enums ──────────────────────────────────────────────────────────────────

export enum MessageType {
  USER = 1,
  BOT = 2,
}

export enum MessageItemType {
  TEXT = 1,
  IMAGE = 2,
  VOICE = 3,
  FILE = 4,
  VIDEO = 5,
}

export enum MessageState {
  NEW = 0,
  GENERATING = 1,
  FINISH = 2,
}

// ── Media ──────────────────────────────────────────────────────────────────

export interface CDNMedia {
  aes_key: string;
  encrypt_query_param: string;
  cdn_url?: string;
}

// ── Message Items ───────────────────────────────────────────────────────────

export interface RefMessage {
  message_item?: MessageItem;
  title?: string;
}

export interface TextItem {
  text: string;
  ref_msg?: RefMessage;
}

export interface ImageItem {
  cdn_media?: CDNMedia;
  /** Alternative field name used by some API versions */
  aeskey?: string;
  media?: { encrypt_query_param: string; aes_key?: string };
  url?: string;
  mid_size?: number;
  hd_size?: number;
  encrypt_type?: number;
}

export interface VoiceItem {
  cdn_media: CDNMedia;
  voice_text?: string;
}

export interface FileItem {
  cdn_media: CDNMedia;
  file_name?: string;
  len?: number;
  encrypt_type?: number;
}

export interface VideoItem {
  cdn_media: CDNMedia;
  video_size?: number;
  encrypt_type?: number;
}

export interface MessageItem {
  type: MessageItemType;
  text_item?: TextItem;
  image_item?: ImageItem;
  voice_item?: VoiceItem;
  file_item?: FileItem;
  video_item?: VideoItem;
}

// ── Weixin Message ──────────────────────────────────────────────────────────

export interface WeixinMessage {
  seq?: number;
  message_id?: number;
  from_user_id?: string;
  to_user_id?: string;
  create_time_ms?: number;
  message_type?: MessageType;
  message_state?: MessageState;
  item_list?: MessageItem[];
  context_token?: string;
}

// ── GetUpdates API ──────────────────────────────────────────────────────────

export interface GetUpdatesReq {
  get_updates_buf?: string;
}

export interface GetUpdatesResp {
  ret?: number;
  retmsg?: string;
  sync_buf: string;
  get_updates_buf: string;
  msgs?: WeixinMessage[];
  longpolling_timeout_ms?: number;
}

// ── SendMessage API ─────────────────────────────────────────────────────────

export interface OutboundMessage {
  from_user_id: string;
  to_user_id: string;
  client_id: string;
  message_type: MessageType;
  message_state: MessageState;
  context_token: string;
  item_list: MessageItem[];
}

export interface SendMessageReq {
  msg: OutboundMessage;
}

// ── GetConfig API (typing ticket) ───────────────────────────────────────────

export interface GetConfigReq {
  ilink_user_id: string;
  context_token?: string;
}

export interface GetConfigResp {
  ret?: number;
  typing_ticket?: string;
}

// ── SendTyping API ──────────────────────────────────────────────────────────

export enum TypingStatus {
  TYPING = 1,
  CANCEL = 2,
}

export interface SendTypingReq {
  ilink_user_id: string;
  typing_ticket: string;
  status: TypingStatus;
}

// ── GetUploadUrl API ────────────────────────────────────────────────────────

export enum UploadMediaType {
  IMAGE = 1,
  VIDEO = 2,
  FILE = 3,
}

export interface GetUploadUrlReq {
  filekey: string;
  media_type: number;
  to_user_id: string;
  rawsize: number;
  rawfilemd5: string;
  filesize: number;
  no_need_thumb: boolean;
  aeskey: string;
}

export interface GetUploadUrlResp {
  errcode: number;
  upload_full_url?: string;
  upload_param?: string;
  url: string;
  aes_key: string;
  encrypt_query_param: string;
}
