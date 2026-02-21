`timescale 1ns/1ps

module tb_counter;
  localparam int WIDTH = 8;

  logic clk = 0;
  logic rst = 1;
  logic [WIDTH-1:0] q;

  // 100 MHz clock
  always #5 clk = ~clk;

  counter #(.WIDTH(WIDTH)) dut (
    .clk(clk),
    .rst(rst),
    .q(q)
  );

  initial begin
    $display("svAi example: counter");
    repeat (3) @(posedge clk);
    rst <= 0;

    // run for a bit
    repeat (100) @(posedge clk);
    $finish;
  end
endmodule
