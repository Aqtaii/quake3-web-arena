#ifndef _WASM_NETINET_IN_H
#define _WASM_NETINET_IN_H

#include <stdint.h>

static inline uint16_t htons(uint16_t v) {
    return (uint16_t)((v >> 8) | (v << 8));
}

static inline uint16_t ntohs(uint16_t v) {
    return htons(v);
}

static inline uint32_t htonl(uint32_t v) {
    return ((v >> 24) & 0xff) | ((v >> 8) & 0xff00) | ((v << 8) & 0xff0000) | ((v << 24) & 0xff000000u);
}

static inline uint32_t ntohl(uint32_t v) {
    return htonl(v);
}

#endif
