#include "../game/q_shared.h"
#include "../client/snd_local.h"

#define WASM_IMPORT(name) __attribute__((import_module("env"), import_name(#name)))

WASM_IMPORT(js_audio_init)        void js_audio_init(int speed, int channels, int samplebits, int samples, void *buffer);
WASM_IMPORT(js_audio_get_dma_pos) int  js_audio_get_dma_pos(void);
WASM_IMPORT(js_audio_submit)      void js_audio_submit(void);
WASM_IMPORT(js_audio_shutdown)    void js_audio_shutdown(void);

#define DMA_SAMPLES 16384 /* mono samples (8192 stereo frames) */
static byte s_dma_buffer[DMA_SAMPLES * 2];
static qboolean s_snd_inited = qfalse;

void Snd_Memset(void *dest, const int val, const size_t count) {
    Com_Memset(dest, val, count);
}

qboolean SNDDMA_Init(void) {
    if (s_snd_inited) {
        return qtrue;
    }

    Com_Memset(s_dma_buffer, 0, sizeof(s_dma_buffer));

    dma.channels = 2;
    dma.samplebits = 16;
    dma.speed = 22050;
    dma.samples = DMA_SAMPLES;
    dma.submission_chunk = 1;
    dma.buffer = s_dma_buffer;

    js_audio_init(dma.speed, dma.channels, dma.samplebits, dma.samples, dma.buffer);

    s_snd_inited = qtrue;
    return qtrue;
}

int SNDDMA_GetDMAPos(void) {
    if (!s_snd_inited) {
        return 0;
    }
    return js_audio_get_dma_pos() & (dma.samples - 1);
}

void SNDDMA_Shutdown(void) {
    if (s_snd_inited) {
        js_audio_shutdown();
        s_snd_inited = qfalse;
    }
}

void SNDDMA_Submit(void) {
    if (s_snd_inited) {
        js_audio_submit();
    }
}

void SNDDMA_BeginPainting(void) {
}
