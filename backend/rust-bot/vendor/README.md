# Azalea client reader patch

`azalea-client` is copied from the same upstream revision as the other Azalea
dependencies: `6249c295` in https://github.com/azalea-rs/azalea. Its license is
included. The manifest resolves inherited workspace dependencies explicitly;
all Azalea dependencies still use that same pinned Git revision.

The only Rust source change is a public `NetworkConnection::try_read` method
delegating to the existing raw packet reader. The AFK network plugin uses it to
bound incoming work without replacing compression, encryption or protocol
handlers. Upstream's private reader otherwise cannot be used by a custom
connection plugin. Cargo's patch applies to the client used by `azalea`.

Keep the patch aligned with Azalea when changing its revision. Remove the local
copy if upstream exposes an equivalent nonblocking reader API.
