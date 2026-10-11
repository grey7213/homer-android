package org.nebula.horizon.composeai.ctf;

/** A distinct provider component prevents Android reusing the APK provider's binder. */
public final class CameraFileProvider extends androidx.core.content.FileProvider {}
