package org.nebula.horizon.composeai.ctf;
import org.junit.Test;
import static org.junit.Assert.*;
import java.io.*;
import java.net.*;
import java.nio.file.*;
import java.security.*;
import java.util.*;

public class ArchivePackDownloadTest {
    @Test public void sourceGateRejectsRedirectTargetsPublicHttpAndCredentialUrls() throws Exception {
        String hash="a".repeat(64);
        assertEquals("http://192.168.1.101:8796/"+hash+".hcap",ArchivePackDownload.source("http://192.168.1.101:8796/",hash,true).toString());
        for(String base:new String[]{"http://example.com/","http://192.168.1.999/","http://10.1.2/","https://user:secret@example.com/","https://example.com/?token=x"})
            try{ArchivePackDownload.source(base,hash,true);fail();}catch(IOException expected){}
        try{ArchivePackDownload.source("http://192.168.1.101/",hash,false);fail();}catch(IOException expected){}
    }
    @Test public void realHttpStreamsPinnedPackageAndRejectsRedirectOrWrongLength() throws Exception {
        byte[] bytes="local data only".getBytes();
        StringBuilder digest=new StringBuilder();
        for(byte value:MessageDigest.getInstance("SHA-256").digest(bytes))digest.append(String.format(Locale.ROOT,"%02x",value & 255));
        String hash=digest.toString();
        ServerSocket server=new ServerSocket(0,3,InetAddress.getByName("127.0.0.1"));
        List<Throwable> errors=Collections.synchronizedList(new ArrayList<>());
        Thread serving=new Thread(()->{
            try{
                for(int request=0;request<3;request++)try(Socket socket=server.accept()){
                    socket.setSoTimeout(5000);
                    BufferedReader input=new BufferedReader(new InputStreamReader(socket.getInputStream(),java.nio.charset.StandardCharsets.US_ASCII));
                    String first=input.readLine();
                    for(String line;(line=input.readLine())!=null && !line.isEmpty();){}
                    OutputStream output=socket.getOutputStream();
                    if(first!=null && first.startsWith("GET /redirect/"))output.write("HTTP/1.1 302 Found\r\nLocation: /ok/\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".getBytes(java.nio.charset.StandardCharsets.US_ASCII));
                    else{
                        output.write(("HTTP/1.1 200 OK\r\nContent-Length: "+bytes.length+"\r\nConnection: close\r\n\r\n").getBytes(java.nio.charset.StandardCharsets.US_ASCII));
                        output.write(bytes);
                    }
                    output.flush();
                }
            }catch(Throwable error){if(!server.isClosed())errors.add(error);}
        },"archive-download-test");
        serving.setDaemon(true);serving.start();
        File directory=Files.createTempDirectory("archive-fetch").toFile();
        String base="http://127.0.0.1:"+server.getLocalPort();
        try{
            File installed=ArchivePackDownload.fetch(base+"/ok/",hash,bytes.length,true,directory,value->{});
            assertArrayEquals(bytes,Files.readAllBytes(installed.toPath()));
            for(String path:new String[]{"/redirect/","/ok/"})try{ArchivePackDownload.fetch(base+path,hash,bytes.length+1,true,directory,value->{});fail();}catch(IOException expected){}
            assertArrayEquals(bytes,Files.readAllBytes(installed.toPath()));
            assertFalse(new File(directory,"incoming.import.tmp").exists());
            serving.join(5000);assertFalse("HTTP fixture must finish",serving.isAlive());assertTrue(errors.toString(),errors.isEmpty());
        }finally{server.close();serving.join(5000);for(File file:Objects.requireNonNull(directory.listFiles()))Files.delete(file.toPath());Files.delete(directory.toPath());}
    }
}
