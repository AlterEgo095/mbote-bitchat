package expo.modules.mboteble

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build

/**
 * Permissions runtime du transport mesh — Android 12+ (S) a introduit
 * BLUETOOTH_SCAN / BLUETOOTH_ADVERTISE / BLUETOOTH_CONNECT ; avant, seule la
 * localisation fine est requise au niveau système pour scanner.
 * Android 13+ (TIRAMISU, API 33) ajoute POST_NOTIFICATIONS : la notification
 * du service foreground (MeshForegroundService) n'est sinon pas affichée.
 */
object BlePermissions {

    fun required(): List<String> {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val ble = mutableListOf(
                Manifest.permission.BLUETOOTH_SCAN,
                Manifest.permission.BLUETOOTH_ADVERTISE,
                Manifest.permission.BLUETOOTH_CONNECT
            )
            // POST_NOTIFICATIONS n'existe qu'à partir de l'API 33 : demandée
            // en même temps que le BLE pour n'afficher qu'une seule invite.
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                ble.add(Manifest.permission.POST_NOTIFICATIONS)
            }
            ble
        } else {
            listOf(Manifest.permission.ACCESS_FINE_LOCATION)
        }
    }

    fun missing(context: Context): List<String> = required().filter {
        context.checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED
    }
}
