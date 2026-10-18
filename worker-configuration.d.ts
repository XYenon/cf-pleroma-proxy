// SPDX-License-Identifier: AGPL-3.0-or-later

interface Env {
	SECRET_KEY_BASE: string;
	USER_AGENT: string;
	MEDIA_FALLBACK?: "pleroma" | "error";
	PREVIEW_MODE?: "worker" | "pleroma" | "original";
	PREVIEW_FALLBACK?: "pleroma" | "original" | "error";
	IMAGES?: ImagesBinding;
	MEDIA?: MediaBinding;
}
