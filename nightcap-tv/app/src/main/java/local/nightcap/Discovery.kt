package local.nightcap

import org.json.JSONObject
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.SocketTimeoutException

/**
 * Finds Nightcap servers on the home network: asks everyone on it ("NIGHTCAP?", a UDP broadcast)
 * and collects the answers. The server's address is where its answer came from; the answer says
 * which port to use. (The server side is nightcap-server's discovery.py.)
 */
object Discovery {
    /** The port servers listen on for the question, like 53 for DNS: part of how the two talk. */
    private const val PORT = 7171
    private val ASK = "NIGHTCAP?".toByteArray()

    class Found(val name: String, val url: String)

    /** The servers that answered within [waitMs]. Runs on a background thread. */
    fun search(waitMs: Int = 2_500): List<Found> = runCatching {
        DatagramSocket().use { socket ->
            socket.broadcast = true
            socket.soTimeout = 300
            val everyone = InetAddress.getByName("255.255.255.255")
            val found = linkedMapOf<String, Found>()
            val until = System.currentTimeMillis() + waitMs
            var asked = 0L
            val buffer = ByteArray(512)
            while (System.currentTimeMillis() < until) {
                // Asked again every second: a broadcast can get lost.
                if (System.currentTimeMillis() - asked > 1_000) {
                    socket.send(DatagramPacket(ASK, ASK.size, everyone, PORT))
                    asked = System.currentTimeMillis()
                }
                val packet = DatagramPacket(buffer, buffer.size)
                try {
                    socket.receive(packet)
                } catch (_: SocketTimeoutException) {
                    continue
                }
                val json = runCatching { JSONObject(String(packet.data, 0, packet.length)) }.getOrNull() ?: continue
                if (json.optString("service") != "nightcap") continue
                val url = "http://${packet.address.hostAddress}:${json.optInt("port", PORT)}"
                found[url] = Found(json.optString("name").ifEmpty { "Nightcap" }, url)
            }
            found.values.toList()
        }
    }.getOrDefault(emptyList())
}
