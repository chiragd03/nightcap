# Coil and OkHttp ship their own consumer rules; nothing else is reflected on.

# libVLC calls back into its Java classes from native code.
-keep class org.videolan.libvlc.** { *; }
