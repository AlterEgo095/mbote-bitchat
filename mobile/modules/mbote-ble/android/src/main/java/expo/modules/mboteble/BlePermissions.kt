package expo.modules.mboteble

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build

/**
 * Permissions BLE runtime — Android 12+ (S) a introduit BLUETOOTH_SCAN /
 * BLUETOOTH_ADVERTISE / BLUETOOTH_CONNECT ; avant, seule la localisation
 * fine est requise au niveau système pour scanner.
 */
object BlePermissions {

    fun required(): List<String> {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            listOf(
                Manifest.permission.BLUETOOTH_SCAN,
                Manifest.permission.BLUETOOTH_ADVERTISE,
                Manifest.permission.BLUETOOTH_CONNECT
            )
        } else {
            listOf(Manifest.permission.ACCESS_FINE_LOCATION)
        }
    }

    fun missing(context: Context): List<String> = required().filter {
        context.checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED
    }
}
