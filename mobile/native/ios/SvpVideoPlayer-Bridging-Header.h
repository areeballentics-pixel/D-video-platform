// Bridging header for SvpPlayer — exposes the svf-core-ffi C ABI to Swift.
//
// The corresponding .a is built from `crates/svf-core-ffi/` and wrapped in
// `svf-core.xcframework`. See `mobile/native/ios/README.md` for build steps.

#ifndef SVP_BRIDGING_HEADER_H
#define SVP_BRIDGING_HEADER_H

#include <stdint.h>

typedef struct SvpHeaderInfo {
    uint8_t  video_id[16];
    uint8_t  tenant_id[16];
    uint8_t  encryption_salt[32];
    uint8_t  encryption_nonce[16];
    uint16_t quality;
    uint32_t chunk_size;
    uint32_t chunk_count;
    uint64_t duration_ms;
    uint32_t width;
    uint32_t height;
    uint64_t original_size;
    uint8_t  content_hash[32];
} SvpHeaderInfo;

int64_t svp_open(const char *path);
int     svp_header(int64_t handle, SvpHeaderInfo *out);
long    svp_decrypt_chunk(
    int64_t handle,
    uint32_t chunk_index,
    const uint8_t *master_key,
    size_t master_key_len,
    uint8_t *out,
    size_t out_capacity);
void    svp_close(int64_t handle);
void    svp_init_logging(void);

#endif /* SVP_BRIDGING_HEADER_H */
